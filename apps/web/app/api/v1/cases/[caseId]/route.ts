import { apiError, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { mandateSummaryProjection } from "@/lib/public-projections";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await context.params;
    const db = await database();
    const mandate = await db.collection("mandates").findOne({ $or: [{ caseId }, { mandateId: caseId }] }, { projection: mandateSummaryProjection });
    if (!mandate) throw new ApiError(404, "Case not found");
    return Response.json({ case: mandate });
  } catch (error) {
    return apiError(error);
  }
}
