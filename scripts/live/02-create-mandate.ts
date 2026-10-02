// Step 2: create and fund the mandate as principal.
//
// One call performs the whole signed flow. The first POST carries no
// authorizations and comes back 428 with the actor EIP-712 payload and the
// EIP-3009 funding authorization to sign; the second POST carries both
// signatures under the same idempotency key so a retry resumes rather than
// creating a second mandate.
//
// The mandate is published to the open docket (no providerWallet) so the
// provider has to discover it, which is the path a real provider agent takes.
import { parseSignature } from "viem";
import { api, currentRunId, loadState, log, must, saveState, walletFor } from "./lib";

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function isoOffsetDays(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

// Criteria describe exactly what the provider will publish: 50 earthquake
// records from the USGS public catalog, each with a resolvable USGS event URL.
export function mandateDocument() {
  return {
    protocol: "mandate-court/1.1",
    requiredSkills: ["research"],
    deliveryTypes: ["dataset"],
    objective:
      "Collect a verifiable dataset of recent earthquake events from the USGS public earthquake catalog and publish it with a resolvable primary source URL for every record, so the records can be independently re-checked against the authoritative catalog.",
    deliverables: [
      "results.json containing at least 40 earthquake records, each populating event_id, place, magnitude, occurred_at, depth_km, and coordinates",
      "sources.json mapping every event_id in results.json to its resolvable USGS event page URL",
      "README.md stating the collection date, the source catalog and query used, and the unit of every numeric field",
    ],
    acceptanceCriteria: [
      {
        id: "C1",
        requirement:
          "results.json contains at least 40 records and every record populates all six required fields (event_id, place, magnitude, occurred_at, depth_km, coordinates) with a non-null value.",
        weightBps: 5_000,
        mandatory: true,
        critical: true,
        severity: "CRITICAL",
        verificationMethod:
          "Download results.json, count the records, and assert every record has all six fields present and non-null.",
        expectedEvidence: ["results.json", "row-count-check"],
      },
      {
        id: "C2",
        requirement:
          "Every event_id in results.json has an entry in sources.json whose URL is an HTTPS URL on the earthquake.usgs.gov domain and resolves to that event.",
        weightBps: 3_000,
        mandatory: true,
        critical: false,
        severity: "HIGH",
        verificationMethod:
          "Download sources.json, confirm one entry per event_id, and check each URL is HTTPS on earthquake.usgs.gov.",
        expectedEvidence: ["sources.json"],
      },
      {
        id: "C3",
        requirement:
          "README.md documents the collection date, the exact USGS catalog query used, and the unit of every numeric field in results.json.",
        weightBps: 2_000,
        mandatory: true,
        critical: false,
        severity: "MEDIUM",
        verificationMethod: "Read README.md and confirm all three items are present and specific.",
        expectedEvidence: ["README.md"],
      },
    ],
    evidenceRequirements: [
      "Every artifact URL is public HTTPS pinned to an immutable revision, specifically a full 40-character commit SHA.",
      "Every declared sha256 matches the bytes actually served at its URL.",
      "Source URLs resolve on the authoritative USGS domain, not a mirror or cache.",
    ],
    acceptanceDeadline: isoOffsetDays(2),
    deliveryDeadline: isoOffsetDays(7),
    payment: { chainId: 84532, token: "USDC", tokenAddress: USDC_ADDRESS, amountAtomic: "2000000" },
    policy: "RESEARCH_DATA_V2",
    allowPartialSettlement: true,
    appealPolicy: { principalAppeals: 1, providerAppeals: 1, lockedRecordOnly: true },
  };
}

async function main() {
  const runId = currentRunId();
  const state = loadState(runId);
  const principal = state.principal as { privateKey: string; address: string };
  const apiKey = state.principalApiKey as string;
  const { account } = walletFor(principal.privateKey);
  const mandate = mandateDocument();
  const idempotencyKey = crypto.randomUUID();

  log("requesting preparation");
  const prep = await api("/api/v1/mandates", {
    method: "POST",
    apiKey,
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({ mandate }),
  });
  log(`preparation -> ${prep.status}`);
  // Detect preparation from the payload, not the status: create answers 202
  // while accept/deliver/claim/appeal answer 428.
  const prepared = prep.body as {
    mandateId: string;
    actorTypedData: Record<string, unknown>;
    fundingAuthorization: { validAfter: string; validBefore: string; nonce: string; typedData: Record<string, unknown> };
  };
  if (prep.status >= 400 && prep.status !== 428) throw new Error(`preparation failed: ${prep.status} ${JSON.stringify(prep.body).slice(0, 500)}`);
  if (!prepared?.actorTypedData) throw new Error("no actorTypedData returned; validate the mandate document");
  if (!prepared?.fundingAuthorization?.typedData) throw new Error("no funding authorization returned; check the payment block");
  log(`mandateId ${prepared.mandateId}`);

  const actorSignature = await account.signTypedData(prepared.actorTypedData as never);
  const actorAuthorization = {
    ...(prepared.actorTypedData as { message: Record<string, unknown> }).message,
    nonce: String((prepared.actorTypedData as { message: { nonce: unknown } }).message.nonce),
    deadline: String((prepared.actorTypedData as { message: { deadline: unknown } }).message.deadline),
    signature: actorSignature,
  };

  const fundingSignature = await account.signTypedData(prepared.fundingAuthorization.typedData as never);
  const split = parseSignature(fundingSignature);
  const fundingAuthorization = {
    validAfter: prepared.fundingAuthorization.validAfter,
    validBefore: prepared.fundingAuthorization.validBefore,
    nonce: prepared.fundingAuthorization.nonce,
    v: split.v === undefined ? Number(split.yParity) + 27 : Number(split.v),
    r: split.r,
    s: split.s,
  };
  log("both authorizations signed, submitting");

  const created = must(
    await api("/api/v1/mandates", {
      method: "POST",
      apiKey,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ mandate, mandateId: prepared.mandateId, actorAuthorization, fundingAuthorization }),
    }),
    "createMandate",
  ) as Record<string, unknown>;

  log(`submitted -> operationId ${created.operationId}`);
  saveState(runId, {
    mandateId: prepared.mandateId,
    mandateDocument: mandate,
    createOperationId: created.operationId,
    createIdempotencyKey: idempotencyKey,
  });
  console.log(JSON.stringify(created, null, 2).slice(0, 900));
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
