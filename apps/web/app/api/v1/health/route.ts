import { database } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const checks: Record<string, string> = { api: "ok" };
  try {
    await database().then((db) => db.command({ ping: 1 }));
    checks.mongodb = "ok";
  } catch (error) {
    checks.mongodb = "unavailable";
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("tls") || message.includes("ssl")) checks.mongodbReason = "tls_handshake";
    else if (message.includes("authentication")) checks.mongodbReason = "authentication";
    else if (message.includes("timed out") || message.includes("timeout")) checks.mongodbReason = "timeout";
    else checks.mongodbReason = "connection";
  }
  return Response.json({ service: "mandate-court", version: "0.1.0", time: new Date().toISOString(), checks }, { status: checks.mongodb === "ok" ? 200 : 503 });
}
