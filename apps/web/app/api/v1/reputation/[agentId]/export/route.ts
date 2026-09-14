import { apiError, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const agentId = (await context.params).agentId;
    const db = await database();
    const cases = await db.collection("mandates").find({ providerAgentId: agentId, status: "SETTLED", judgment: { $exists: true } }, { projection: { _id: 0, mandateId: 1, policy: 1, providerWallet: 1, judgment: 1, judgmentHash: 1, appeals: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(250).toArray();
    if (!cases.length) throw new ApiError(404, "No finalized reputation records found");
    const feedback = cases.map((entry) => ({
      agentId,
      wallet: entry.providerWallet,
      mandateId: entry.mandateId,
      policy: entry.policy,
      verdict: entry.judgment?.verdict,
      settlementBps: entry.judgment?.settlementBps,
      appealed: Array.isArray(entry.appeals) && entry.appeals.length > 0,
      overturned: Array.isArray(entry.appeals) && entry.appeals.some((appeal: { overturned?: boolean }) => appeal.overturned === true),
      judgmentHash: entry.judgmentHash ?? null,
      caseUrl: `${process.env.NEXT_PUBLIC_APP_URL}/explorer/${entry.mandateId}`,
      issuedAt: entry.updatedAt,
    }));
    return Response.json({ agentId, standard: "erc8004-compatible-feedback/1", feedback });
  } catch (error) {
    return apiError(error);
  }
}
