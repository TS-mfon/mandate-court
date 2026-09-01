import { afterEach, describe, expect, it, vi } from "vitest";
import { deliveryManifestSchema, mandateSchema } from "../packages/schemas/src/index";
import { courtAgentCard } from "../apps/web/lib/agent-card";
import { actorTypedData } from "../apps/web/lib/action-auth";
import { normalizeCliArgs, resolveCliPath } from "../packages/cli/src/args";
import { MandateCourtClient } from "../packages/sdk/src/index";
import { successfulFinalizedExecution } from "../apps/web/lib/genlayer";
import { deliveryTimestampIsCurrent } from "../apps/web/lib/delivery-time";
import { terminalRelayError } from "../apps/web/lib/processor-errors";
import { compactCaseId } from "../apps/web/lib/case-display";
import { mandateTransactionFields } from "../apps/web/lib/relay-transactions";
import { mandateSummaryProjection, publicAgentProjection } from "../apps/web/lib/public-projections";

afterEach(() => vi.unstubAllGlobals());

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

describe("CLI argument forwarding", () => {
  it("removes pnpm's literal separator", () => {
    expect(normalizeCliArgs(["--", "mandates", "create", "--file", "mandate.json"])).toEqual([
      "mandates",
      "create",
      "--file",
      "mandate.json",
    ]);
  });

  it("resolves files from the caller's initial directory", () => {
    expect(resolveCliPath("fixtures/mandate.json", "/workspace/mandate-court")).toBe(
      "/workspace/mandate-court/fixtures/mandate.json",
    );
  });
});

describe("SDK signing challenges", () => {
  it("returns an intentional HTTP 428 preparation payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ actorTypedData: { primaryType: "ActorIntent" } }), {
      status: 428,
      headers: { "content-type": "application/json" },
    })));
    const client = new MandateCourtClient({ baseUrl: "https://mandate.example" });
    await expect(client.prepareAccept("MC-001")).resolves.toMatchObject({ actorTypedData: { primaryType: "ActorIntent" } });
  });

  it("still rejects unexpected error statuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })));
    const client = new MandateCourtClient({ baseUrl: "https://mandate.example" });
    await expect(client.prepareAccept("MC-001")).rejects.toMatchObject({ status: 403 });
  });
});

describe("GenLayer finalized receipt compatibility", () => {
  it("accepts the explicit execution result shape", () => {
    expect(successfulFinalizedExecution({ txExecutionResultName: "FINISHED_WITH_RETURN" })).toBe(true);
    expect(successfulFinalizedExecution({ txExecutionResultName: "FINISHED_WITH_ERROR", result_name: "MAJORITY_AGREE" })).toBe(false);
  });

  it("accepts StudioNet majority-agree receipts when execution detail is absent", () => {
    expect(successfulFinalizedExecution({ result_name: "MAJORITY_AGREE" })).toBe(true);
    expect(successfulFinalizedExecution({ resultName: "MAJORITY_DISAGREE" })).toBe(false);
    expect(successfulFinalizedExecution({ result_name: "NO_MAJORITY" })).toBe(false);
  });
});

describe("delivery time integrity", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");

  it("accepts a current timestamp before the deadline", () => {
    expect(deliveryTimestampIsCurrent("2026-08-31T11:55:00.000Z", "2026-09-01T00:00:00.000Z", now)).toBe(true);
  });

  it("rejects materially backdated, future, and post-deadline timestamps", () => {
    expect(deliveryTimestampIsCurrent("2026-08-31T11:30:00.000Z", "2026-09-01T00:00:00.000Z", now)).toBe(false);
    expect(deliveryTimestampIsCurrent("2026-08-31T12:30:00.000Z", "2026-09-01T00:00:00.000Z", now)).toBe(false);
    expect(deliveryTimestampIsCurrent("2026-08-31T12:05:00.000Z", "2026-08-31T12:00:00.000Z", now)).toBe(false);
  });
});

describe("relay retry classification", () => {
  it("terminates cryptographically irrecoverable authorization errors", () => {
    expect(terminalRelayError(new Error("FiatTokenV2: invalid signature"))).toBe(true);
    expect(terminalRelayError(new Error("authorization expired"))).toBe(true);
  });

  it("retries network and provider availability errors", () => {
    expect(terminalRelayError(new Error("fetch failed"))).toBe(false);
    expect(terminalRelayError(new Error("relayer temporarily unavailable"))).toBe(false);
  });
});

describe("case display identity", () => {
  it("keeps long protocol identifiers out of headings", () => {
    expect(compactCaseId("MC_940c1ce705f84b0c894c0c54b84bed3b")).toBe("MC-940C1CE7");
  });
});

describe("relay transaction persistence", () => {
  it("keeps lifecycle transaction hashes in distinct fields", () => {
    expect(mandateTransactionFields("CREATE_MANDATE", "0xcreate")).toMatchObject({ baseTransactionHash: "0xcreate", createTransactionHash: "0xcreate" });
    expect(mandateTransactionFields("ACCEPT_MANDATE", "0xaccept")).toEqual({ acceptTransactionHash: "0xaccept" });
    expect(mandateTransactionFields("SUBMIT_DELIVERY", "0xdelivery")).toEqual({ deliveryTransactionHash: "0xdelivery" });
    expect(mandateTransactionFields("SETTLEMENT", "0xsettle")).toMatchObject({ settlementTransactionHash: "0xsettle" });
  });

  it("does not write undefined transaction fields", () => {
    expect(mandateTransactionFields("CREATE_MANDATE")).toEqual({});
    expect(mandateTransactionFields("UNKNOWN", "0xhash")).toEqual({});
  });
});

describe("public API projections", () => {
  it("never exposes signed authorization or settlement attestation material", () => {
    for (const field of ["actorAuthorization", "fundingAuthorization", "acceptAuthorization", "deliveryAuthorization", "settlementAttestation", "deliveryPreparation"]) {
      expect(mandateSummaryProjection[field as keyof typeof mandateSummaryProjection]).toBe(0);
    }
  });

  it("keeps agent callback endpoints private", () => {
    expect(publicAgentProjection.callbackUrl).toBe(0);
  });
});

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
