const deliveryTimestampToleranceMs = 15 * 60 * 1000;

export function deliveryTimestampIsCurrent(submittedAt: string, deliveryDeadline: string, now = Date.now()) {
  const submittedTime = Date.parse(submittedAt);
  const deadlineTime = Date.parse(deliveryDeadline);
  if (!Number.isFinite(submittedTime) || !Number.isFinite(deadlineTime)) return false;
  return Math.abs(submittedTime - now) <= deliveryTimestampToleranceMs && submittedTime <= deadlineTime;
}
