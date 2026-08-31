import { reputationFor } from "@/lib/reputation";
import { apiError } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    return Response.json(await reputationFor((await context.params).agentId));
  } catch (error) {
    return apiError(error);
  }
}
