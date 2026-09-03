import { apiError, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { mandatePublicCaseProjection } from "@/lib/public-projections";
import { readGenLayerCase } from "@/lib/genlayer";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await context.params;
    const db = await database();
    const mandate = await db.collection("mandates").findOne({ $or: [{ caseId }, { mandateId: caseId }] }, { projection: mandatePublicCaseProjection });
    if (!mandate) throw new ApiError(404, "Case not found");
    if (!["FINALIZED", "SETTLEMENT_PENDING", "SETTLED"].includes(String(mandate.status)) || !mandate.judgmentHash) {
      throw new ApiError(409, "Case has no finalized judgment");
    }
    let contractCase: Record<string, any>;
    try {
      contractCase = await readGenLayerCase(String(mandate.mandateId), mandate.genlayerContractAddress ? String(mandate.genlayerContractAddress) : undefined);
    } catch {
      throw new ApiError(503, "Finalized GenLayer judgment is temporarily unavailable");
    }
    return Response.json({ case: { ...mandate, judgment: contractCase.judgment, genlayerCase: contractCase, judgmentSource: "GENLAYER_CONTRACT" } });
  } catch (error) {
    return apiError(error);
  }
}
