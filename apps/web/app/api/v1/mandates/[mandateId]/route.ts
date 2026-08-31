import { apiError, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ mandateId: string }> }) {
  try {
    const { mandateId } = await context.params;
    const db = await database();
    const mandate = await db.collection("mandates").findOne({ mandateId }, { projection: { _id: 0, actorAuthorization: 0, fundingAuthorization: 0, acceptAuthorization: 0, deliveryAuthorization: 0, settlementAttestation: 0, manifest: 0, snapshots: 0, deliveryPreparation: 0 } });
    if (!mandate) throw new ApiError(404, "Mandate not found");
    return Response.json({ mandate });
  } catch (error) {
    return apiError(error);
  }
}
