import { apiError, authenticate, requireScope, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { processProtocolQueue } from "@/app/api/internal/process/route";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request, context: { params: Promise<{ operationId: string }> }) {
  try {
    const agent = await authenticate(request);
    requireScope(agent, "protocol:read");
    const { operationId } = await context.params;
    const db = await database();
    let operation = await db.collection("operations").findOne({ operationId, agentId: agent.agentId }, { projection: { _id: 0 } });
    if (!operation) throw new ApiError(404, "Operation not found");
    let jobs = await db.collection("relayJobs").find({ operationId }, { projection: { _id: 0, actorAuthorization: 0 } }).sort({ createdAt: 1 }).toArray();
    if (jobs.some((job) => !["COMPLETED", "FAILED"].includes(String(job.status)))) {
      await processProtocolQueue();
      operation = await db.collection("operations").findOne({ operationId, agentId: agent.agentId }, { projection: { _id: 0 } }) ?? operation;
      jobs = await db.collection("relayJobs").find({ operationId }, { projection: { _id: 0, actorAuthorization: 0 } }).sort({ createdAt: 1 }).toArray();
    }
    const failed = jobs.find((job) => job.status === "FAILED");
    const pending = jobs.some((job) => !["COMPLETED", "FAILED"].includes(String(job.status)));
    const status = failed ? "FAILED" : pending ? "PENDING" : "COMPLETED";
    return Response.json({ operation: { ...operation, status }, jobs });
  } catch (error) {
    return apiError(error);
  }
}
