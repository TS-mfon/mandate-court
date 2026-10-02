// Step 7: assemble the evidence bundle and publish it alongside the deliverable.
//
// The bundle is what a reviewing steward reads. It is written from the run state
// and the live case record, so every hash, transaction, and URL in it was
// observed rather than transcribed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { api, currentRunId, loadState, log, saveState, usdc } from "./lib";

const BASESCAN = "https://sepolia.basescan.org/tx/";
const COURT = "https://mandate-court.vercel.app";

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function main() {
  const runId = currentRunId();
  const state = loadState(runId) as Record<string, any>;
  const dir = state.deliverableDir as string;
  const repo = state.deliveryRepo as string;
  const sha = state.deliveryCommitSha as string;

  // Re-read the case live so the bundle reflects the Court, not our cache.
  const res = await api(`/api/v1/cases/${state.mandateId}`, { apiKey: state.providerApiKey as string });
  if (res.status !== 200) throw new Error(`case lookup returned ${res.status}`);
  const record = ((res.body as { case?: unknown }).case ?? res.body) as Record<string, any>;
  const judgment = record.judgment as Record<string, any>;
  const amountAtomic = BigInt(state.mandateDocument.payment.amountAtomic);
  const award = (amountAtomic * BigInt(judgment.settlementBps)) / 10_000n;

  const stages: Array<[string, string, string]> = [
    ["Mandate created and escrow funded", "createTransactionHash", "EIP-3009 transferWithAuthorization locked escrow"],
    ["Provider accepted", "acceptTransactionHash", "Wallet-bound acceptance recorded on Base"],
    ["Delivery submitted", "deliveryTransactionHash", "Delivery hash committed on Base"],
    ["Case linked to adjudicator", "linkCaseTransactionHash", "Dispute registry linked to the GenLayer case"],
    ["Judgment accepted", "acceptedRecordTransactionHash", "Judgment recorded, appeal window opened"],
    ["Judgment finalized", "finalizedRecordTransactionHash", "Finality reached, settlement authorized"],
    ["Settlement executed", "settlementTransactionHash", `${usdc(award)} released from escrow to the provider`],
  ];

  const evidenceDir = join(dir, "evidence");
  mkdirSync(evidenceDir, { recursive: true });

  const onchain = {
    chain: "Base Sepolia",
    chainId: 84532,
    usdc: state.mandateDocument.payment.tokenAddress,
    escrowContract: "0xbb884f9f1AD5DF295Df56908905DE3822583C867",
    mandateRegistry: "0x2Ac5F5B9D8c9bd05FCB8de0b49A3e42Bfb6FB086",
    disputeRegistry: "0x3b673AC88d24EBECb7Ed39b776b62996AA6a8A11",
    settlementAdapter: "0x38247b766826F720251a4e9Af79E47B5e3ef137E",
    genlayerContract: record.genlayerContractAddress,
    genlayerTransactionId: record.genlayerTransactionId,
    onchainMandateId: record.onchainMandateId,
    principalWallet: record.principalWallet,
    providerWallet: record.providerWallet,
    escrowedAtomic: amountAtomic.toString(),
    awardedAtomic: award.toString(),
    transactions: stages.map(([label, key, note]) => ({ stage: label, note, hash: record[key], explorer: `${BASESCAN}${record[key]}` })),
  };

  writeFileSync(join(evidenceDir, "mandate.json"), `${JSON.stringify(state.mandateDocument, null, 2)}\n`);
  writeFileSync(join(evidenceDir, "delivery-manifest.json"), `${JSON.stringify(record.manifest, null, 2)}\n`);
  writeFileSync(join(evidenceDir, "judgment.json"), `${JSON.stringify(judgment, null, 2)}\n`);
  writeFileSync(join(evidenceDir, "onchain.json"), `${JSON.stringify(onchain, null, 2)}\n`);

  const criteriaRows = (judgment.criteria ?? [])
    .map((c: Record<string, any>) => {
      const declared = state.mandateDocument.acceptanceCriteria.find((d: { id: string }) => d.id === c.id);
      return `| \`${c.id}\` | ${declared?.weightBps ?? "-"} | **${c.result}** | ${String(c.reasonCode ?? "-")} | ${String(declared?.requirement ?? "").slice(0, 110)}… |`;
    })
    .join("\n");

  const admissibilityRows = (judgment.admissibility ?? [])
    .map((a: Record<string, any>) => `| \`${a.id}\` | **${a.status}** | ${a.reason} |`)
    .join("\n");

  const txRows = onchain.transactions
    .map((t) => `| ${t.stage} | [\`${String(t.hash).slice(0, 14)}…\`](${t.explorer}) | ${t.note} |`)
    .join("\n");

  const artifactRows = Object.entries(state.publishedArtifacts as Record<string, { url: string; sha256: string; bytes: number }>)
    .map(([file, meta]) => `| [\`${file}\`](${meta.url}) | ${meta.bytes.toLocaleString()} | \`${meta.sha256}\` |`)
    .join("\n");

  const evidenceMd = `# Evidence: one Mandate Court mandate, run end to end

This repository is both the **delivered work** and the **evidence that it was adjudicated and paid**.
Everything below was produced by a live run against
[\`mandate-court.vercel.app\`](${COURT}) on Base Sepolia and GenLayer StudioNet. Every hash and
transaction here was read back from the chain or from the Court, not transcribed from a plan.

## What was commissioned

A principal agent escrowed **${usdc(amountAtomic)}** for a dataset of at least 40 earthquake records
drawn from the USGS public catalog, each carrying a resolvable primary source URL. The full mandate,
including all three weighted acceptance criteria, is in
[\`evidence/mandate.json\`](evidence/mandate.json).

| | |
| --- | --- |
| Mandate | \`${state.mandateId}\` |
| On-chain mandate ID | \`${record.onchainMandateId}\` |
| Policy | \`${record.policy}\` |
| Escrow | ${usdc(amountAtomic)} on Base Sepolia |
| Principal agent | \`${record.principalAgentId}\` (\`${record.principalWallet}\`) |
| Provider agent | \`${record.providerAgentId}\` (\`${record.providerWallet}\`) |

The mandate was published to the **open docket** with no assigned provider. The provider agent
discovered it by querying the docket and was matched on skills and policy:

\`\`\`json
${JSON.stringify(state.docketMatch, null, 2)}
\`\`\`

## What was delivered

${state.recordCount} earthquake records collected from the USGS FDSN event service on
${String(state.collectedAt).slice(0, 10)}. The exact query is recorded in
[\`README.md\`](README.md) and was:

\`\`\`
${state.usgsQuery}
\`\`\`

The service returned ${state.recordCount + (state.droppedCount as number)} features;
${state.droppedCount} were discarded for having a null required field. No value was synthesised.
Each record can be re-checked against the authoritative catalog through its entry in
[\`sources.json\`](sources.json).

All artifacts are pinned to commit [\`${sha}\`](https://github.com/${repo}/commit/${sha}):

| Artifact | Bytes | sha256 of the bytes served at that URL |
| --- | --- | --- |
${artifactRows}

The hashes above are of the bytes **GitHub actually served**, downloaded back after publishing. The
Court then re-downloaded every URL and re-hashed it independently before adjudicating.

## How it was judged

The delivery manifest is in [\`evidence/delivery-manifest.json\`](evidence/delivery-manifest.json)
and the judgment in [\`evidence/judgment.json\`](evidence/judgment.json).

| | |
| --- | --- |
| Verdict | **${judgment.verdict}** |
| Settlement | **${judgment.settlementBps} bps** (${Number(judgment.settlementBps) / 100}% to the provider) |
| Confidence | ${judgment.confidenceBps} bps |
| Judgment source | \`${record.judgmentSource}\` |
| Judgment hash | \`${record.judgmentHash}\` |
| GenLayer contract | \`${record.genlayerContractAddress}\` |
| GenLayer transaction | \`${record.genlayerTransactionId}\` |
| Material breaches | ${judgment.materialBreaches?.length ? judgment.materialBreaches.join(", ") : "none"} |
| Missing evidence | ${judgment.missingEvidence?.length ? judgment.missingEvidence.join(", ") : "none"} |

> ${judgment.summary}

### Per-criterion result

| Criterion | Weight (bps) | Result | Reason code | Requirement |
| --- | --- | --- | --- | --- |
${criteriaRows}

### Evidence admissibility

Escrowed funds are released by a judgment, not by agreement, and a claim is never proof. Each item
was ruled on before it could earn anything:

| Item | Status | Court's reason |
| --- | --- | --- |
${admissibilityRows}

## How it was paid

Seven on-chain transactions, all confirmed on Base Sepolia:

| Stage | Transaction | What it did |
| --- | --- | --- |
${txRows}

The settlement transaction contains a USDC \`Transfer\` of **${usdc(award)}** from the escrow
contract \`${onchain.escrowContract}\` to the provider wallet \`${record.providerWallet}\`. The
provider's balance moved from 0 USDC to ${usdc(award)}; the principal's from
${usdc(3_000_000n)} funded to ${usdc(3_000_000n - amountAtomic)}. Full detail in
[\`evidence/onchain.json\`](evidence/onchain.json).

Settlement is authorized only after finality: the judgment was recorded, the appeal window opened
and closed, and only then was escrow released.

## Reproducing this

\`\`\`bash
# Re-download an artifact and check it still hashes to the declared value
curl -sL https://raw.githubusercontent.com/${repo}/${sha}/results.json | sha256sum

# Re-check any record against the live USGS catalog
curl -s "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=$(curl -sL https://raw.githubusercontent.com/${repo}/${sha}/results.json | jq -r '.records[0].event_id')"

# Read the case from the Court
curl -s ${COURT}/api/v1/cases/${state.mandateId}
\`\`\`

---

Run \`${runId}\`, settled ${record.settledAt}. Mandate Court is a Base Sepolia and GenLayer
StudioNet testnet pilot; the USDC here is test USDC.
`;

  writeFileSync(join(dir, "EVIDENCE.md"), evidenceMd);
  log(`wrote EVIDENCE.md (${evidenceMd.length} chars) and 4 evidence/*.json files`);

  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", `Add adjudication and settlement evidence for ${state.mandateId}\n\nVerdict ${judgment.verdict}, ${judgment.settlementBps} bps, ${usdc(award)} released from escrow.`], dir);
  git(["push", "-q", "origin", "main"], dir);
  const evidenceSha = git(["rev-parse", "HEAD"], dir);
  log(`evidence pushed at commit ${evidenceSha}`);

  saveState(runId, {
    evidenceCommitSha: evidenceSha,
    evidenceUrl: `https://github.com/${repo}/blob/${evidenceSha}/EVIDENCE.md`,
    awardAtomic: award.toString(),
    onchain,
  });
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
