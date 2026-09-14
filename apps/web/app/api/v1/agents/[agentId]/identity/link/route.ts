import { apiError, authenticate, requireScope, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { keccak256, stringToHex, verifyMessage } from "viem";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const auth = await authenticate(request);
    requireScope(auth, "protocol:write");
    const { agentId } = await context.params;
    if (agentId !== auth.agentId) throw new ApiError(403, "Agent identity does not match API key");
    const body = await request.json();
    if (!body.erc8004AgentId || !body.registryAddress || !body.signature) throw new ApiError(422, "erc8004AgentId, registryAddress, and signature are required");
    if (!/^0x[a-fA-F0-9]{40}$/.test(String(body.registryAddress))) throw new ApiError(422, "registryAddress must be an EVM address");
    if (!Number.isInteger(Number(body.chainId)) || Number(body.chainId) <= 0) throw new ApiError(422, "chainId must be a positive integer");
    const message = `Mandate Court ERC-8004 identity link\nAgent: ${agentId}\nERC-8004 Agent: ${body.erc8004AgentId}\nRegistry: ${body.registryAddress}`;
    const valid = await verifyMessage({ address: auth.walletAddress, message, signature: body.signature });
    if (!valid) throw new ApiError(403, "Invalid wallet signature");
    const identity = { agentId: String(body.erc8004AgentId), registryAddress: String(body.registryAddress), chainId: Number(body.chainId), identityUri: body.identityUri ? String(body.identityUri) : undefined, linkHash: keccak256(stringToHex(message)), linkedAt: new Date() };
    const db = await database();
    await db.collection("agents").updateOne({ agentId }, { $set: { erc8004: identity, updatedAt: new Date() } });
    return Response.json({ agentId, erc8004: identity });
  } catch (error) {
    return apiError(error);
  }
}
