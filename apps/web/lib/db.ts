import { MongoClient, type Db } from "mongodb";
import { randomUUID } from "node:crypto";
import { env } from "./env";

declare global {
  var mandateCourtMongo: Promise<MongoClient> | undefined;
}

export async function database(): Promise<Db> {
  const config = env();
  global.mandateCourtMongo ??= new MongoClient(config.MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 0,
  }).connect();
  const client = await global.mandateCourtMongo;
  return client.db(config.MONGODB_DB);
}

export async function ensureIndexes() {
  const db = await database();
  await Promise.all([
    db.collection("challenges").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("challenges").createIndex({ challengeId: 1 }, { unique: true }),
    db.collection("apiKeys").createIndex({ keyHash: 1 }, { unique: true }),
    db.collection("apiKeys").createIndex({ agentId: 1, revokedAt: 1 }),
    db.collection("agents").createIndex({ walletAddress: 1 }, { unique: true }),
    db.collection("agents").createIndex({ agentId: 1 }, { unique: true }),
    db.collection("mandates").createIndex({ mandateId: 1 }, { unique: true }),
    db.collection("mandates").createIndex({ status: 1, policy: 1, createdAt: -1 }),
    db.collection("operations").createIndex({ idempotencyKey: 1, agentId: 1 }, { unique: true, sparse: true }),
    db.collection("relayJobs").createIndex({ status: 1, nextAttemptAt: 1 }),
    db.collection("processorLeases").createIndex({ name: 1 }, { unique: true }),
  ]);
}

const PROCESSOR_LEASE_NAME = "default";
const PROCESSOR_LEASE_MS = 120_000;

export async function acquireProcessorLease(db: Db) {
  const owner = randomUUID();
  const now = new Date();
  try {
    const result = await db.collection("processorLeases").findOneAndUpdate(
      { name: PROCESSOR_LEASE_NAME, $or: [{ expiresAt: { $lte: now } }, { owner }] },
      { $set: { name: PROCESSOR_LEASE_NAME, owner, expiresAt: new Date(now.getTime() + PROCESSOR_LEASE_MS), updatedAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    return result?.owner === owner ? owner : null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: number }).code === 11000) return null;
    throw error;
  }
}

export async function releaseProcessorLease(db: Db, owner: string) {
  await db.collection("processorLeases").deleteOne({ name: PROCESSOR_LEASE_NAME, owner });
}
