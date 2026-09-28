import type { Filter } from "mongodb";
import { mandateSummaryProjection } from "./public-projections";

export type DocketQuery = {
  query: Filter<Record<string, unknown>>;
  limit: number;
  cursor?: string;
};

export function parseDocketQuery(url: URL): DocketQuery {
  const limitValue = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.floor(limitValue), 1), 100) : 50;
  const query: Filter<Record<string, unknown>> = {
    status: { $in: ["OPEN", "FUNDED"] },
    $or: [{ providerAgentId: null }, { providerAgentId: "" }],
  };
  const skills = url.searchParams.getAll("skill").filter(Boolean);
  const policy = url.searchParams.get("policy");
  const deliveryType = url.searchParams.get("deliveryType");
  const chainId = url.searchParams.get("chainId");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (skills.length === 1) query["mandate.requiredSkills"] = skills[0];
  if (skills.length > 1) query["mandate.requiredSkills"] = { $all: skills };
  if (policy) query.policy = policy;
  if (deliveryType) query["mandate.deliveryTypes"] = deliveryType;
  if (chainId && Number.isInteger(Number(chainId))) query["mandate.payment.chainId"] = Number(chainId);
  if (cursor) {
    const date = new Date(cursor);
    if (!Number.isNaN(date.getTime())) query.createdAt = { $lt: date };
  }
  return { query, limit, cursor };
}

export function docketProjection() {
  return mandateSummaryProjection;
}

export function docketMatch(mandate: Record<string, any>, url: URL) {
  const reasons = ["unassigned", "escrow-backed", "acceptance-window-open"];
  const requestedSkills = url.searchParams.getAll("skill").filter(Boolean);
  if (requestedSkills.length) reasons.push("required-skills-match");
  if (url.searchParams.get("policy")) reasons.push("policy-match");
  if (url.searchParams.get("deliveryType")) reasons.push("delivery-type-match");
  if (url.searchParams.get("chainId")) reasons.push("chain-match");
  return {
    score: reasons.length,
    reasons,
    requiredSkills: mandate.mandate?.requiredSkills ?? [],
    deliveryTypes: mandate.mandate?.deliveryTypes ?? [],
  };
}
