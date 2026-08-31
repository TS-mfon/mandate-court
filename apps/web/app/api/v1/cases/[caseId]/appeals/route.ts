import { z } from "zod";
import { apiError, authenticate, requireScope, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { beginOperation } from "@/lib/operations";
import { canonicalHash } from "@/lib/crypto";
import { actionHash, actorTypedData, appealPayloadHash, currentActorNonce, type ActorAuthorization, verifyActorAuthorization } from "@/lib/action-auth";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  try {
    const agent = await authenticate(request);
    requireScope(agent, "protocol:appeal");
    const { caseId } = await context.params;
    const body = z.object({ grounds: z.string().min(20).max(2_000), actorAuthorization: z.unknown().optional(), authorizationDeadline: z.union([z.string(), z.number()]).optional() }).parse(await request.json());
    const db = await database();
    const mandate = await db.collection("mandates").findOne({ $or: [{ caseId }, { mandateId: caseId }] });
    if (!mandate) throw new ApiError(404, "Case not found");
    const role = mandate.principalAgentId === agent.agentId ? "principal" : mandate.providerAgentId === agent.agentId ? "provider" : null;
    if (!role) throw new ApiError(403, "Only a case party may appeal");
    if (!mandate.genlayerTransactionId) throw new ApiError(409, "No GenLayer judgment exists");
    if (["SETTLEMENT_PENDING", "SETTLED", "CANCELLED", "EXPIRED"].includes(String(mandate.status))) {
      throw new ApiError(409, "Appeal window is closed");
    }
    const appeals = Array.isArray(mandate.appeals) ? mandate.appeals : [];
    if (appeals.some((appeal: { role: string }) => appeal.role === role)) throw new ApiError(409, `${role} appeal already used`);
    const actorNonce = await currentActorNonce(agent.walletAddress);
    const payloadHash = appealPayloadHash(mandate.onchainMandateId, body.grounds, agent.walletAddress);
    const unsigned = { mandateId: mandate.onchainMandateId, action: actionHash("appeal"), payloadHash, actor: agent.walletAddress, nonce: String(actorNonce), deadline: String(body.authorizationDeadline ?? Math.floor(Date.now() / 1000) + 3600) };
    if (!body.actorAuthorization) return Response.json({ actorTypedData: actorTypedData(unsigned) }, { status: 428 });
    const valid = await verifyActorAuthorization(agent, body.actorAuthorization as ActorAuthorization, { mandateId: mandate.onchainMandateId, action: actionHash("appeal"), payloadHash, nonce: actorNonce });
    if (!valid) throw new ApiError(403, "Invalid actor authorization");
    const started = await beginOperation(request, agent.agentId, "APPEAL_CASE", canonicalHash(body));
    if (started.existing) return Response.json(started.operation);
    const appeal = { appealId: `appeal_${crypto.randomUUID()}`, role, agentId: agent.agentId, walletAddress: agent.walletAddress, grounds: body.grounds, actorAuthorization: body.actorAuthorization, status: "QUEUED", originalTransactionId: mandate.genlayerTransactionId, createdAt: new Date() };
    await db.collection("mandates").updateOne({ _id: mandate._id }, { $push: { appeals: appeal } as never, $set: { status: "APPEAL_PENDING", updatedAt: new Date() } });
    await db.collection("relayJobs").insertOne({ operationId: started.operation.operationId, type: "GENLAYER_APPEAL", mandateId: mandate.mandateId, appealId: appeal.appealId, status: "PENDING", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() });
    await db.collection("relayJobs").insertOne({ operationId: started.operation.operationId, type: "RECORD_APPEAL", mandateId: mandate.mandateId, appealId: appeal.appealId, status: "PENDING", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() });
    return Response.json({ appealId: appeal.appealId, operationId: started.operation.operationId, status: "QUEUED" }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
