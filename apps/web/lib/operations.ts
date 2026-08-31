import { database } from "./db";
import { identifier } from "./crypto";
import { ApiError } from "./auth";

export async function beginOperation(request: Request, agentId: string, type: string, fingerprint?: string) {
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) throw new Error("Idempotency-Key header required");
  const db = await database();
  const existing = await db.collection("operations").findOne({ agentId, idempotencyKey });
  if (existing) {
    if (fingerprint && existing.fingerprint && existing.fingerprint !== fingerprint) throw new ApiError(409, "Idempotency-Key was reused for a different request");
    return { existing: true, operation: existing };
  }
  const operation = {
    operationId: identifier("op"),
    agentId,
    idempotencyKey,
    type,
    fingerprint,
    status: "QUEUED",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  try {
    await db.collection("operations").insertOne(operation);
    return { existing: false, operation };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: number }).code === 11000) {
      const duplicate = await db.collection("operations").findOne({ agentId, idempotencyKey });
      if (duplicate) return { existing: true, operation: duplicate };
    }
    throw error;
  }
}
