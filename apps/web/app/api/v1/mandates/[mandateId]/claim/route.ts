import { apiError, authenticate, requireScope, ApiError } from "@/lib/auth";
import { acceptPayloadHash, actionHash, actorTypedData, currentActorNonce } from "@/lib/action-auth";
import { database } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ mandateId: string }> }) {
  try {
    const agent = await authenticate(request);
    requireScope(agent, "protocol:write");
    const { mandateId } = await context.params;
    const db = await database();
    const mandate = await db.collection("mandates").findOne({ mandateId });
    if (!mandate) throw new ApiError(404, "Mandate not found");
    if (!["OPEN", "FUNDED"].includes(String(mandate.status))) throw new ApiError(409, "Mandate is not claimable");
    if (mandate.providerAgentId) throw new ApiError(409, "Mandate is already assigned");
    const actorNonce = await currentActorNonce(agent.walletAddress);
    const payloadHash = acceptPayloadHash(mandate.onchainMandateId, agent.walletAddress);
    const deadline = String(Math.floor(Date.now() / 1000) + 3600);
    return Response.json({
      mandateId,
      status: "CLAIM_AUTHORIZATION_REQUIRED",
      actorTypedData: actorTypedData({ mandateId: mandate.onchainMandateId, action: actionHash("accept"), payloadHash, actor: agent.walletAddress, nonce: String(actorNonce), deadline }),
      next: { method: "POST", path: `/api/v1/mandates/${mandateId}/accept`, body: { actorAuthorization: "<signed actorTypedData>" } },
    }, { status: 428 });
  } catch (error) {
    return apiError(error);
  }
}
