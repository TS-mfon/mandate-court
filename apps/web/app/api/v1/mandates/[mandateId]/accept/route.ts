import { apiError, authenticate, requireScope, ApiError } from "@/lib/auth";
import { acceptPayloadHash, actionHash, actorTypedData, currentActorNonce, type ActorAuthorization, verifyActorAuthorization } from "@/lib/action-auth";
import { database } from "@/lib/db";
import { beginOperation } from "@/lib/operations";
import { canonicalHash } from "@/lib/crypto";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ mandateId: string }> }) {
  try {
    const agent = await authenticate(request);
    requireScope(agent, "protocol:write");
    const { mandateId } = await context.params;
    const body = await request.json();
    const db = await database();
    const mandate = await db.collection("mandates").findOne({ mandateId });
    if (!mandate) throw new ApiError(404, "Mandate not found");
    if (!["FUNDED", "OPEN"].includes(String(mandate.status))) throw new ApiError(409, "Mandate is not open for acceptance");
    if (mandate.providerAgentId && mandate.providerAgentId !== agent.agentId) throw new ApiError(403, "Mandate is assigned to another provider");
    const payloadHash = acceptPayloadHash(mandate.onchainMandateId, agent.walletAddress);
    const actorNonce = await currentActorNonce(agent.walletAddress);
    const unsigned = { mandateId: mandate.onchainMandateId, action: actionHash("accept"), payloadHash, actor: agent.walletAddress, nonce: String(actorNonce), deadline: String(body.authorizationDeadline ?? Math.floor(Date.now() / 1000) + 3600) };
    if (!body.actorAuthorization) return Response.json({ actorTypedData: actorTypedData(unsigned) }, { status: 428 });
    const valid = await verifyActorAuthorization(agent, body.actorAuthorization as ActorAuthorization, { mandateId: mandate.onchainMandateId, action: actionHash("accept"), payloadHash, nonce: actorNonce });
    if (!valid) throw new ApiError(403, "Invalid actor authorization");
    const started = await beginOperation(request, agent.agentId, "ACCEPT_MANDATE", canonicalHash(body));
    if (started.existing) return Response.json(started.operation);
    const claimed = await db.collection("mandates").findOneAndUpdate(
      { mandateId, status: { $in: ["FUNDED", "OPEN"] }, $or: [{ providerAgentId: null }, { providerAgentId: agent.agentId }] },
      { $set: { providerAgentId: agent.agentId, providerWallet: agent.walletAddress, status: "ACCEPT_RELAY_PENDING", acceptAuthorization: body.actorAuthorization, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!claimed) throw new ApiError(409, "Another provider already accepted this mandate");
    await db.collection("relayJobs").insertOne({ operationId: started.operation.operationId, type: "ACCEPT_MANDATE", mandateId, status: "PENDING", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() });
    return Response.json({ mandateId, operationId: started.operation.operationId, status: "ACCEPT_RELAY_PENDING" }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
