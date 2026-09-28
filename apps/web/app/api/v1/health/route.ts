import { database } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const checks: Record<string, string> = { api: "ok" };
  if (!process.env.WEBHOOK_ENCRYPTION_KEY) checks.webhookEncryption = "fallback_api_key_pepper";
  else checks.webhookEncryption = "ok";
  try {
    const db = await database();
    await db.command({ ping: 1 });
    checks.mongodb = "ok";
    const [pendingRelayJobs, pendingWebhooks, deadLetterWebhooks] = await Promise.all([
      db.collection("relayJobs").countDocuments({ status: { $in: ["PENDING", "SUBMITTED", "WAITING_FOR_BASE_SUBMISSION"] } }),
      db.collection("webhookJobs").countDocuments({ status: "PENDING" }),
      db.collection("webhookJobs").countDocuments({ status: "DEAD_LETTER" }),
    ]);
    return Response.json({
      service: "mandate-court",
      version: "0.2.0",
      time: new Date().toISOString(),
      checks,
      queue: { pendingRelayJobs, pendingWebhooks, deadLetterWebhooks },
      integrations: {
        base: Boolean(process.env.BASE_SEPOLIA_RPC_URL && process.env.MANDATE_REGISTRY_ADDRESS),
        genlayer: Boolean(process.env.GENLAYER_RPC_URL && process.env.GENLAYER_CONTRACT_ADDRESS),
        oneShot: Boolean(process.env.ONESHOT_RELAYER_URL),
        gelatoFallback: Boolean(process.env.GELATO_RELAY_API_KEY),
      },
    }, { status: 200 });
  } catch (error) {
    checks.mongodb = "unavailable";
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("tls") || message.includes("ssl")) checks.mongodbReason = "tls_handshake";
    else if (message.includes("authentication")) checks.mongodbReason = "authentication";
    else if (message.includes("timed out") || message.includes("timeout")) checks.mongodbReason = "timeout";
    else checks.mongodbReason = "connection";
  }
  return Response.json({ service: "mandate-court", version: "0.2.0", time: new Date().toISOString(), checks }, { status: checks.mongodb === "ok" ? 200 : 503 });
}
