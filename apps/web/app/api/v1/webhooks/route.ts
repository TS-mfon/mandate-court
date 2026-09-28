import { apiError, authenticate, requireScope } from "@/lib/auth";
import { database } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const agent = await authenticate(request);
    requireScope(agent, "protocol:read");
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 100);
    const db = await database();
    const jobs = await db.collection("webhookJobs").find(
      { agentId: agent.agentId },
      { projection: { _id: 0, body: 0, signature: 0 } },
    ).sort({ createdAt: -1 }).limit(Number.isFinite(limit) ? limit : 50).toArray();
    return Response.json({ webhooks: jobs });
  } catch (error) {
    return apiError(error);
  }
}
