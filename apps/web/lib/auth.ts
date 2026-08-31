import { verifyMessage } from "viem";
import { database } from "./db";
import { hashApiKey } from "./crypto";

export type AuthenticatedAgent = {
  agentId: string;
  walletAddress: `0x${string}`;
  scopes: string[];
};

export async function authenticate(request: Request): Promise<AuthenticatedAgent> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new ApiError(401, "API key required");
  const apiKey = authorization.slice(7);
  const db = await database();
  const record = await db.collection("apiKeys").findOne({ keyHash: hashApiKey(apiKey), revokedAt: null });
  if (!record) throw new ApiError(401, "Invalid API key");
  await db.collection("apiKeys").updateOne({ _id: record._id }, { $set: { lastUsedAt: new Date() } });
  return {
    agentId: String(record.agentId),
    walletAddress: String(record.walletAddress).toLowerCase() as `0x${string}`,
    scopes: (record.scopes as string[]) ?? ["protocol:write"],
  };
}

export function requireScope(agent: AuthenticatedAgent, scope: string) {
  if (!agent.scopes.includes(scope)) throw new ApiError(403, `API key lacks required scope: ${scope}`);
}

export async function verifyWalletChallenge(input: { challengeId: string; signature: `0x${string}` }) {
  const db = await database();
  const challenge = await db.collection("challenges").findOne({ challengeId: input.challengeId, usedAt: null });
  if (!challenge || new Date(challenge.expiresAt) < new Date()) throw new ApiError(400, "Challenge expired or unknown");
  const valid = await verifyMessage({
    address: String(challenge.walletAddress) as `0x${string}`,
    message: String(challenge.message),
    signature: input.signature,
  });
  if (!valid) throw new ApiError(403, "Invalid wallet signature");
  await db.collection("challenges").updateOne({ _id: challenge._id }, { $set: { usedAt: new Date() } });
  return String(challenge.walletAddress).toLowerCase() as `0x${string}`;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export function apiError(error: unknown) {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message, details: error.details }, { status: error.status });
  }
  if (error && typeof error === "object" && "issues" in error) {
    return Response.json({ error: "Validation failed", details: (error as { issues: unknown }).issues }, { status: 422 });
  }
  console.error(error);
  return Response.json({ error: "Internal court service error" }, { status: 500 });
}
