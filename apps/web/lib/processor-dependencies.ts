export type DependencyState = "READY" | "WAITING" | "BLOCKED";

export function adjudicationDependencyState(input: {
  deliveryJobStatus?: string;
  deliveryTransactionHash?: string;
}) : DependencyState {
  if (input.deliveryJobStatus === "FAILED") return "BLOCKED";
  if (input.deliveryJobStatus !== "COMPLETED" || !input.deliveryTransactionHash) return "WAITING";
  return "READY";
}
