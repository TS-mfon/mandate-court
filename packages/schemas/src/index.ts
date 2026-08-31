import { z } from "zod";

export const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
export const hashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
export const policySchema = z.enum([
  "GENERAL_V1",
  "RESEARCH_DATA_V1",
  "SOFTWARE_WEB_V1",
  "CREATIVE_VISUAL_V1",
]);

export const criterionSchema = z.object({
  id: z.string().min(1).max(64),
  requirement: z.string().min(8).max(2_000),
  weightBps: z.number().int().positive().max(10_000),
  mandatory: z.boolean().default(true),
  critical: z.boolean().default(false),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  verificationMethod: z.string().min(3).max(500),
  expectedEvidence: z.array(z.string().min(1).max(100)).max(12),
});

export const mandateSchema = z
  .object({
    protocol: z.literal("mandate-court/1.0").default("mandate-court/1.0"),
    providerAgentId: z.string().min(3).max(100).optional(),
    providerWallet: addressSchema.optional(),
    objective: z.string().min(12).max(4_000),
    deliverables: z.array(z.string().min(3).max(1_000)).min(1).max(32),
    acceptanceCriteria: z.array(criterionSchema).min(1).max(32),
    evidenceRequirements: z.array(z.string().min(3).max(1_000)).min(1).max(32),
    acceptanceDeadline: z.string().datetime(),
    deliveryDeadline: z.string().datetime(),
    payment: z.object({
      chainId: z.literal(84532).default(84532),
      token: z.literal("USDC"),
      tokenAddress: addressSchema,
      amountAtomic: z.string().regex(/^\d+$/),
    }),
    policy: policySchema,
    allowPartialSettlement: z.boolean().default(true),
    appealPolicy: z.object({
      principalAppeals: z.literal(1).default(1),
      providerAppeals: z.literal(1).default(1),
      lockedRecordOnly: z.literal(true).default(true),
    }),
  })
  .superRefine((value, ctx) => {
    const total = value.acceptanceCriteria.reduce((sum, criterion) => sum + criterion.weightBps, 0);
    if (total !== 10_000) {
      ctx.addIssue({ code: "custom", message: "Criterion weights must total 10000", path: ["acceptanceCriteria"] });
    }
    if (Date.parse(value.deliveryDeadline) <= Date.parse(value.acceptanceDeadline)) {
      ctx.addIssue({ code: "custom", message: "Delivery deadline must follow acceptance deadline", path: ["deliveryDeadline"] });
    }
  });

export const artifactSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(["json", "text", "image", "code", "website", "document", "archive"]),
  url: z.string().url().startsWith("https://"),
  sha256: hashSchema,
  mediaType: z.string().min(3).max(150),
  criteria: z.array(z.string().min(1).max(64)).max(32),
});

export const evidenceSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(["source", "web", "onchain", "image", "metadata", "test", "document"]),
  url: z.string().url().startsWith("https://"),
  sha256: hashSchema,
  supports: z.array(z.string().min(1).max(64)).max(32),
});

export const deliveryManifestSchema = z.object({
  protocol: z.literal("mdp/1.0"),
  mandateId: z.string().min(3).max(100),
  providerAgentId: z.string().min(3).max(100),
  submittedAt: z.string().datetime(),
  summary: z.string().min(3).max(4_000),
  artifacts: z.array(artifactSchema).min(1).max(32),
  evidence: z.array(evidenceSchema).min(1).max(16),
});

export const judgmentSchema = z.object({
  schemaVersion: z.literal("1.0"),
  caseId: z.string().min(3).max(100),
  verdict: z.enum(["FULFILLED", "PARTIALLY_FULFILLED", "BREACHED", "UNDETERMINED"]),
  confidenceBps: z.number().int().min(0).max(10_000),
  settlementBps: z.number().int().min(0).max(10_000),
  criteria: z.array(
    z.object({
      id: z.string(),
      result: z.enum(["PASS", "FAIL", "PARTIAL", "UNVERIFIABLE"]),
      severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
      weightBps: z.number().int().min(0).max(10_000),
      evidenceRefs: z.array(z.string()),
      reasonCode: z.string(),
      reason: z.string(),
    }),
  ),
  admissibility: z.array(z.object({ id: z.string(), status: z.enum(["ADMISSIBLE", "INADMISSIBLE", "UNVERIFIABLE"]), reason: z.string() })),
  contradictions: z.array(z.string()),
  materialBreaches: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  appealGrounds: z.array(z.string()),
  summary: z.string(),
});

export const agentRegistrationSchema = z.object({
  walletAddress: addressSchema,
  name: z.string().min(2).max(100),
  description: z.string().min(10).max(1_000),
  skills: z.array(z.string().min(2).max(80)).max(32),
  agentCardUrl: z.string().url().startsWith("https://").optional(),
  callbackUrl: z.string().url().startsWith("https://").optional(),
});

export type MandateInput = z.infer<typeof mandateSchema>;
export type DeliveryManifest = z.infer<typeof deliveryManifestSchema>;
export type Judgment = z.infer<typeof judgmentSchema>;
