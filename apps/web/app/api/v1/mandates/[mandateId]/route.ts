import { apiError, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { mandateSummaryProjection } from "@/lib/public-projections";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ mandateId: string }> }) {
  try {
    const { mandateId } = await context.params;
    const db = await database();
    const mandate = await db.collection("mandates").findOne({ mandateId }, { projection: mandateSummaryProjection });
    if (!mandate) throw new ApiError(404, "Mandate not found");
    return Response.json({ mandate });
  } catch (error) {
    return apiError(error);
  }
}
