import { createHmac } from "node:crypto";
import { database } from "./db";
import { env } from "./env";

export async function enqueueWebhook(agentId: string, type: string, payload: unknown) {
  const db = await database();
  const agent = await db.collection("agents").findOne({ agentId });
  if (!agent?.callbackUrl) return null;
  const body = JSON.stringify({ id: crypto.randomUUID(), type, createdAt: new Date().toISOString(), payload });
  const signature = createHmac("sha256", env().WEBHOOK_SIGNING_SECRET ?? env().API_KEY_PEPPER).update(body).digest("hex");
  const job = { agentId, callbackUrl: agent.callbackUrl, body, signature, status: "PENDING", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() };
  await db.collection("webhookJobs").insertOne(job);
  return job;
}
