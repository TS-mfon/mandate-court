import { randomUUID } from "node:crypto";
import { database } from "./db";
import { env } from "./env";
import { decryptWebhookSecret, webhookSignature } from "./crypto";

export function webhookHeaders(job: { eventId: string; signatureTimestamp: number; signature: string }) {
  return {
    "content-type": "application/json",
    "x-mandate-court-signature": `t=${job.signatureTimestamp},v1=${job.signature}`,
    "x-mandate-court-event-id": job.eventId,
    "x-mandate-court-timestamp": String(job.signatureTimestamp),
    "user-agent": "MandateCourt-Webhook/1.0",
  };
}

export async function enqueueWebhook(agentId: string, type: string, payload: unknown) {
  const db = await database();
  const agent = await db.collection("agents").findOne({ agentId });
  if (!agent?.callbackUrl) return null;
  const eventId = randomUUID();
  const createdAt = new Date();
  const body = JSON.stringify({ id: eventId, type, createdAt: createdAt.toISOString(), payload });
  const signatureTimestamp = Math.floor(createdAt.getTime() / 1000);
  let secret = env().WEBHOOK_SIGNING_SECRET ?? env().API_KEY_PEPPER;
  if (agent.webhookSecretCiphertext) secret = decryptWebhookSecret(String(agent.webhookSecretCiphertext));
  const signature = webhookSignature(secret, signatureTimestamp, body);
  const job = { eventId, agentId, callbackUrl: agent.callbackUrl, body, signature, signatureVersion: "v1", signatureTimestamp, status: "PENDING", attempts: 0, nextAttemptAt: createdAt, createdAt };
  await db.collection("webhookJobs").insertOne(job);
  return job;
}
