import { z } from "zod";
import { database } from "@/lib/db";
import { apiError, authenticate, requireScope, verifyWalletChallenge, ApiError } from "@/lib/auth";
import { hashApiKey, identifier, newApiKey } from "@/lib/crypto";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = z.object({ challengeId: z.string(), signature: z.string().startsWith("0x"), name: z.string().min(2).max(80) }).parse(await request.json());
    const walletAddress = await verifyWalletChallenge({ challengeId: input.challengeId, signature: input.signature as `0x${string}` });
    const db = await database();
    const existingAgent = await db.collection("agents").findOne({ walletAddress });
    let agentId: string;
    if (!existingAgent) {
      const createdAgentId = identifier("agent");
      await db.collection("agents").insertOne({ agentId: createdAgentId, walletAddress, name: input.name, description: "Unconfigured autonomous agent", skills: [], createdAt: new Date(), updatedAt: new Date() });
      agentId = createdAgentId;
    } else {
      agentId = String(existingAgent.agentId);
    }
    const apiKey = newApiKey();
    const record = { keyId: identifier("key"), keyPrefix: apiKey.slice(0, 16), keyHash: hashApiKey(apiKey), agentId, walletAddress, name: input.name, scopes: ["protocol:read", "protocol:write", "protocol:appeal"], revokedAt: null, createdAt: new Date(), lastUsedAt: null };
    await db.collection("apiKeys").insertOne(record);
    return Response.json({ apiKey, keyId: record.keyId, keyPrefix: record.keyPrefix, agentId, walletAddress }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function GET(request: Request) {
  try {
    const agent = await authenticate(request);
    requireScope(agent, "protocol:read");
    const db = await database();
    const keys = await db.collection("apiKeys").find({ agentId: agent.agentId, revokedAt: null }, { projection: { _id: 0, keyHash: 0 } }).toArray();
    return Response.json({ keys });
  } catch (error) {
    return apiError(error);
  }
}


export async function DELETE(request: Request) {
  try {
    const agent = await authenticate(request);
    requireScope(agent, "protocol:write");
    const input = z.object({ keyId: z.string().min(1) }).parse(await request.json());
    const db = await database();
    const result = await db.collection("apiKeys").updateOne(
      { keyId: input.keyId, agentId: agent.agentId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedByKeyId: request.headers.get("x-api-key-id") ?? null } },
    );
    if (result.modifiedCount !== 1) throw new ApiError(404, "Active API key not found");
    return Response.json({ keyId: input.keyId, status: "REVOKED" });
  } catch (error) {
    return apiError(error);
  }
}
