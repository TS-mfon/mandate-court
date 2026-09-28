/**
 * Hand-written skeletons that already satisfy every constraint in
 * `@mandate-court/schemas`. They are deliberately not derived from the zod schemas at
 * runtime so this package keeps a two-dependency footprint; `tests/mcp-server.test.ts`
 * parses both templates with the real schemas, so drift fails the gate instead of
 * reaching an agent.
 */

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PLACEHOLDER_SHA256 = `0x${"0".repeat(64)}`;

function isoOffsetDays(days: number, from = Date.now()) {
  return new Date(from + days * 86_400_000).toISOString();
}

export function mandateTemplate(now = Date.now()) {
  return {
    protocol: "mandate-court/1.1",
    requiredSkills: ["research"],
    deliveryTypes: ["dataset"],
    objective:
      "Replace this with a specific, checkable statement of the outcome you are paying for.",
    deliverables: [
      "results.json containing one record per subject with every required field populated",
      "README.md stating collection date, source list, and per-field units",
    ],
    acceptanceCriteria: [
      {
        id: "C1",
        requirement:
          "results.json contains at least 40 records and every record populates all six required fields with a non-null value.",
        weightBps: 5_000,
        mandatory: true,
        critical: true,
        severity: "CRITICAL",
        verificationMethod:
          "Download results.json, count records, and assert every record has all six fields present and non-null.",
        expectedEvidence: ["results.json", "row-count-check"],
      },
      {
        id: "C2",
        requirement:
          "Every record cites a resolvable HTTPS source URL on a .gov, .edu, or recognised publisher domain.",
        weightBps: 3_000,
        mandatory: true,
        critical: false,
        severity: "HIGH",
        verificationMethod:
          "Download sources.json and resolve each cited URL, checking the domain against the permitted list.",
        expectedEvidence: ["sources.json"],
      },
      {
        id: "C3",
        requirement:
          "README.md documents the collection date, the full source list, and the unit of every numeric field.",
        weightBps: 2_000,
        mandatory: true,
        critical: false,
        severity: "MEDIUM",
        verificationMethod: "Read README.md and confirm all three sections are present and specific.",
        expectedEvidence: ["README.md"],
      },
    ],
    evidenceRequirements: [
      "Every artifact URL is public HTTPS pinned to an immutable revision such as a full commit SHA.",
      "Every declared sha256 matches the bytes served at its URL.",
    ],
    acceptanceDeadline: isoOffsetDays(2, now),
    deliveryDeadline: isoOffsetDays(7, now),
    payment: {
      chainId: BASE_SEPOLIA_CHAIN_ID,
      token: "USDC",
      tokenAddress: BASE_SEPOLIA_USDC,
      amountAtomic: "2000000",
    },
    policy: "RESEARCH_DATA_V2",
    allowPartialSettlement: true,
    appealPolicy: { principalAppeals: 1, providerAppeals: 1, lockedRecordOnly: true },
  };
}

export const MANDATE_CONSTRAINTS = [
  "acceptanceCriteria[].weightBps must total exactly 10000.",
  "deliveryDeadline must be strictly after acceptanceDeadline; both are ISO-8601 datetimes.",
  "payment.amountAtomic is a decimal string in USDC's 6 decimals, so 2000000 is 2 USDC.",
  "payment.chainId is 84532 (Base Sepolia) and payment.token is USDC.",
  "policy is one of GENERAL_V1, RESEARCH_DATA_V1, RESEARCH_DATA_V2, SOFTWARE_WEB_V1, CREATIVE_VISUAL_V1.",
  "1-32 deliverables, 1-32 acceptanceCriteria, 1-32 evidenceRequirements, at most 12 expectedEvidence per criterion.",
  "severity is one of CRITICAL, HIGH, MEDIUM, LOW. critical: true makes failure a material breach that can zero the whole award.",
  "Omit providerWallet and providerAgentId to publish on the open docket; set them to assign the mandate directly.",
];

export function manifestTemplate(mandateId = "MC_00000000000000000000000000000000", providerAgentId = "agent_replace_me", now = Date.now()) {
  return {
    protocol: "mdp/1.1",
    mandateId,
    providerAgentId,
    submittedAt: new Date(now).toISOString(),
    summary: "Replace this with a plain description of what was delivered.",
    artifacts: [
      {
        id: "results",
        type: "json",
        url: "https://raw.githubusercontent.com/OWNER/REPO/REPLACE_WITH_40_CHAR_COMMIT_SHA/results.json",
        sha256: PLACEHOLDER_SHA256,
        mediaType: "application/json",
        criteria: ["C1"],
        immutableRevision: "REPLACE_WITH_40_CHAR_COMMIT_SHA",
      },
      {
        id: "readme",
        type: "document",
        url: "https://raw.githubusercontent.com/OWNER/REPO/REPLACE_WITH_40_CHAR_COMMIT_SHA/README.md",
        sha256: PLACEHOLDER_SHA256,
        mediaType: "text/markdown",
        criteria: ["C3"],
        immutableRevision: "REPLACE_WITH_40_CHAR_COMMIT_SHA",
      },
    ],
    evidence: [
      {
        id: "source-registry",
        type: "source",
        url: "https://raw.githubusercontent.com/OWNER/REPO/REPLACE_WITH_40_CHAR_COMMIT_SHA/sources.json",
        sha256: PLACEHOLDER_SHA256,
        supports: ["C2"],
        sourceType: "PRIMARY",
        claim: "sources.json cites a resolvable primary source URL for every record in results.json.",
      },
    ],
  };
}

export const MANIFEST_CONSTRAINTS = [
  "protocol is mdp/1.0 or mdp/1.1.",
  "Every url must start with https:// and resolve publicly. Private-range and internal hosts are blocked.",
  "Every sha256 is 0x followed by exactly 64 hex characters. sha256sum omits the 0x prefix, so add it.",
  "Publish first, then download the published bytes and hash those. Hashing the local file breaks on any transport change.",
  "Pin URLs to an immutable revision: a full commit SHA or a content address. Branch and 'latest' URLs fail on the next push.",
  "artifacts[].criteria and evidence[].supports hold acceptance-criterion IDs from the mandate. An item mapped to nothing earns nothing, and a criterion nothing maps to fails.",
  "artifacts[].type is one of json, text, image, code, website, document, archive.",
  "evidence[].type is one of source, web, onchain, image, metadata, test, document.",
  "1-32 artifacts, 1-16 evidence items, 1 MB per item.",
  "Replace every PLACEHOLDER sha256 and REPLACE_WITH_40_CHAR_COMMIT_SHA before submitting.",
];
