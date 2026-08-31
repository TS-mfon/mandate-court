export function compactCaseId(caseId: string) {
  const normalized = caseId.replace(/^MC[_-]?/i, "").replace(/[^a-zA-Z0-9]/g, "");
  return `MC-${normalized.slice(0, 8).toUpperCase() || "UNKNOWN"}`;
}

export function caseStatusClass(verdict?: string) {
  if (verdict === "BREACHED") return "breach";
  if (verdict === "UNDETERMINED") return "review";
  return "";
}
