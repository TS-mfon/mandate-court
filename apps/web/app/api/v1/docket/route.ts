import { apiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { mandateSummaryProjection } from "@/lib/public-projections";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const skill = url.searchParams.get("skill");
    const policy = url.searchParams.get("policy");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
    const query: Record<string, unknown> = { status: { $in: ["OPEN", "FUNDED"] }, $or: [{ providerAgentId: null }, { providerAgentId: "" }] };
    if (skill) query["mandate.requiredSkills"] = skill;
    if (policy) query.policy = policy;
    const db = await database();
    const mandates = await db.collection("mandates").find(query, { projection: mandateSummaryProjection }).sort({ createdAt: -1 }).limit(Number.isFinite(limit) ? limit : 50).toArray();
    return Response.json({ mandates, count: mandates.length });
  } catch (error) {
    return apiError(error);
  }
}
