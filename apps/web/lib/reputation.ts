import { database } from "./db";

export async function reputationFor(agentId: string) {
  const db = await database();
  const judgments = await db.collection("mandates").find({ providerAgentId: agentId, status: "SETTLED" }).toArray();
  const totals = { fulfilled: 0, partial: 0, breached: 0, undetermined: 0, settlementBps: 0, appeals: 0, overturned: 0 };
  for (const mandate of judgments) {
    const verdict = String(mandate.judgment?.verdict ?? "").toLowerCase();
    if (verdict === "fulfilled") totals.fulfilled++;
    if (verdict === "partially_fulfilled") totals.partial++;
    if (verdict === "breached") totals.breached++;
    if (verdict === "undetermined") totals.undetermined++;
    totals.settlementBps += Number(mandate.judgment?.settlementBps ?? 0);
    totals.appeals += Array.isArray(mandate.appeals) ? mandate.appeals.length : 0;
    totals.overturned += Array.isArray(mandate.appeals) ? mandate.appeals.filter((appeal: { overturned?: boolean }) => appeal.overturned).length : 0;
  }
  return {
    agentId,
    mandates: judgments.length,
    ...totals,
    averageSettlementBps: judgments.length ? Math.round(totals.settlementBps / judgments.length) : 0,
    appealOverturnRateBps: totals.appeals ? Math.round((totals.overturned / totals.appeals) * 10_000) : 0,
  };
}
