export const mandatePrivateFields = {
  actorAuthorization: 0,
  fundingAuthorization: 0,
  acceptAuthorization: 0,
  deliveryAuthorization: 0,
  settlementAttestation: 0,
  deliveryPreparation: 0,
} as const;

export const mandateSummaryProjection = {
  _id: 0,
  ...mandatePrivateFields,
  manifest: 0,
  snapshots: 0,
} as const;

export const mandatePublicCaseProjection = {
  _id: 0,
  ...mandatePrivateFields,
  snapshots: 0,
} as const;

export const publicAgentProjection = {
  _id: 0,
  callbackUrl: 0,
} as const;
