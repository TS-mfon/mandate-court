import { describe, expect, it } from "vitest";
import { deliveryManifestSchema, mandateSchema } from "../packages/schemas/src/index";
import { courtAgentCard } from "../apps/web/lib/agent-card";
import { actorTypedData } from "../apps/web/lib/action-auth";

const mandate = {
  protocol: "mandate-court/1.0",
  objective: "Research twenty independently verifiable companies.",
  deliverables: ["results.json"],
  acceptanceCriteria: [
    { id: "C1", requirement: "Return twenty unique records", weightBps: 6000, mandatory: true, critical: false, severity: "HIGH", verificationMethod: "Count records", expectedEvidence: ["dataset"] },
    { id: "C2", requirement: "Provide public source for every record", weightBps: 4000, mandatory: true, critical: true, severity: "CRITICAL", verificationMethod: "Fetch every source", expectedEvidence: ["sources"] },
  ],
  evidenceRequirements: ["Public HTTPS evidence"],
  acceptanceDeadline: "2026-09-01T00:00:00.000Z",
  deliveryDeadline: "2026-09-03T00:00:00.000Z",
  payment: { chainId: 84532, token: "USDC", tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amountAtomic: "50000000" },
  policy: "RESEARCH_DATA_V1",
  allowPartialSettlement: true,
  appealPolicy: { principalAppeals: 1, providerAppeals: 1, lockedRecordOnly: true },
};

describe("mandate schema", () => {
  it("accepts a decision-complete weighted mandate", () => {
    expect(mandateSchema.parse(mandate).acceptanceCriteria).toHaveLength(2);
  });

  it("rejects weights that do not total 10000", () => {
    const invalid = structuredClone(mandate);
    invalid.acceptanceCriteria[1].weightBps = 3000;
    expect(() => mandateSchema.parse(invalid)).toThrow(/total 10000/);
  });

  it("rejects delivery deadlines before acceptance", () => {
    const invalid = { ...mandate, deliveryDeadline: "2026-08-30T00:00:00.000Z", acceptanceDeadline: "2026-09-01T00:00:00.000Z" };
    expect(() => mandateSchema.parse(invalid)).toThrow(/follow acceptance/);
  });
});

describe("delivery manifest schema", () => {
  it("requires public HTTPS artifacts and evidence", () => {
    const validHash = `0x${"1".repeat(64)}`;
    const parsed = deliveryManifestSchema.parse({
      protocol: "mdp/1.0",
      mandateId: "MC-001",
      providerAgentId: "agent_provider",
      submittedAt: "2026-09-02T00:00:00.000Z",
      summary: "Completed delivery",
      artifacts: [{ id: "A1", type: "json", url: "https://example.com/results.json", sha256: validHash, mediaType: "application/json", criteria: ["C1"] }],
      evidence: [{ id: "E1", type: "source", url: "https://example.com/sources.json", sha256: validHash, supports: ["C1"] }],
    });
    expect(parsed.protocol).toBe("mdp/1.0");
  });

  it("rejects non-HTTPS evidence", () => {
    const validHash = `0x${"1".repeat(64)}`;
    expect(() => deliveryManifestSchema.parse({ protocol: "mdp/1.0", mandateId: "MC-001", providerAgentId: "agent_provider", submittedAt: "2026-09-02T00:00:00.000Z", summary: "Completed", artifacts: [{ id: "A1", type: "json", url: "http://example.com/results.json", sha256: validHash, mediaType: "application/json", criteria: [] }], evidence: [{ id: "E1", type: "source", url: "https://example.com", sha256: validHash, supports: [] }] })).toThrow();
  });
});

describe("agent discovery card", () => {
  it("advertises only implemented production interfaces", () => {
    process.env.MONGODB_URI ??= "mongodb://localhost:27017";
    process.env.MONGODB_DB ??= "mandate_court";
    process.env.API_KEY_PEPPER ??= "test-pepper-that-is-long-enough";
    process.env.NEXT_PUBLIC_APP_URL = "https://mandate-court.vercel.app";

    const card = courtAgentCard();

    expect(card.url).toBe("https://mandate-court.vercel.app/api/v1");
    expect(card.preferredTransport).toBe("HTTP+JSON");
    expect(card.documentationUrl).toBe("https://mandate-court.vercel.app/docs");
    expect(card.additionalInterfaces).toEqual([]);
  });
});

describe("typed data transport", () => {
  it("is JSON serializable for autonomous API clients", () => {
    process.env.MANDATE_REGISTRY_ADDRESS = "0x1111111111111111111111111111111111111111";
    const typedData = actorTypedData({
      mandateId: `0x${"1".repeat(64)}`,
      action: `0x${"2".repeat(64)}`,
      payloadHash: `0x${"3".repeat(64)}`,
      actor: "0x2222222222222222222222222222222222222222",
      nonce: "0",
      deadline: "1788300000",
    });
    expect(() => JSON.stringify(typedData)).not.toThrow();
    expect(typedData.message.nonce).toBe("0");
  });
});
