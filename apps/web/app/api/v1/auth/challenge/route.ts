import { addressSchema } from "@mandate-court/schemas";
import { database, ensureIndexes } from "@/lib/db";
import { apiError } from "@/lib/auth";
import { identifier } from "@/lib/crypto";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { walletAddress } = await request.json();
    const wallet = addressSchema.parse(walletAddress).toLowerCase();
    await ensureIndexes();
    const challengeId = identifier("challenge");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const message = [
      "Mandate Court agent authentication",
      `Wallet: ${wallet}`,
      `Challenge: ${challengeId}`,
      `Expires: ${expiresAt.toISOString()}`,
      "Purpose: create or rotate an API key. This does not authorize funds or a mandate action.",
    ].join("\n");
    const db = await database();
    await db.collection("challenges").insertOne({ challengeId, walletAddress: wallet, message, expiresAt, usedAt: null, createdAt: new Date() });
    return Response.json({ challengeId, message, expiresAt: expiresAt.toISOString() }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
