// G5 oracle. Proves the deliverable and evidence are genuinely published,
// immutably pinned, and byte-identical to what the Court adjudicated.
//
// Re-downloads every artifact URL from the manifest the Court actually judged,
// recomputes sha256 over the served bytes, and compares. A branch URL would
// pass a naive existence check while remaining mutable, so each URL must also
// contain a 40-character commit SHA, and the repository must be public, which
// is checked by fetching without credentials.
import { createHash } from "node:crypto";
import { api, currentRunId, loadState } from "../live/lib";

function sha256(bytes: Buffer) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

async function main() {
  const failures: string[] = [];
  const state = loadState(currentRunId()) as Record<string, any>;
  const repo = state.deliveryRepo as string;

  // Read the manifest back from the Court rather than from local state, so the
  // gate checks what was adjudicated, not what we intended to submit.
  const res = await api(`/api/v1/cases/${state.mandateId}`, { apiKey: state.providerApiKey as string });
  if (res.status !== 200) throw new Error(`case lookup returned ${res.status}`);
  const record = ((res.body as { case?: unknown }).case ?? res.body) as Record<string, any>;
  const manifest = record.manifest as Record<string, any>;
  if (!manifest) throw new Error("the case carries no delivery manifest");

  const items = [
    ...(manifest.artifacts ?? []).map((a: Record<string, any>) => ({ kind: "artifact", ...a })),
    ...(manifest.evidence ?? []).map((e: Record<string, any>) => ({ kind: "evidence", ...e })),
  ];
  console.log(`repository ${repo}`);
  console.log(`manifest carries ${items.length} item(s) the Court adjudicated`);
  console.log();

  for (const item of items) {
    const url = String(item.url);
    const label = `${item.kind}:${item.id}`;

    // Immutability: a full commit SHA must appear in the path.
    const pinned = /\/[0-9a-f]{40}\//.test(url);
    // Public: fetch with no credentials at all.
    const response = await fetch(url, { cache: "no-store" });
    const bytes = response.ok ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
    const digest = response.ok ? sha256(bytes) : "(not fetched)";
    const matches = digest === item.sha256;

    console.log(`  ${label.padEnd(26)} HTTP ${response.status}  pinned=${pinned}  hash=${matches ? "match" : "MISMATCH"}  ${bytes.length} bytes`);
    if (!response.ok) failures.push(`${label} ${url} returned HTTP ${response.status} without credentials`);
    if (!pinned) failures.push(`${label} URL is not pinned to a 40-character commit SHA: ${url}`);
    if (response.ok && !matches) failures.push(`${label} served bytes hash to ${digest} but the manifest declared ${item.sha256}`);
    if (response.ok && item.contentLength && Number(item.contentLength) !== bytes.length) {
      failures.push(`${label} declared contentLength ${item.contentLength} but served ${bytes.length} bytes`);
    }
    // Every item must map to at least one criterion, or it earns nothing.
    const mapped = (item.criteria ?? item.supports ?? []) as string[];
    if (!mapped.length) failures.push(`${label} maps to no acceptance criterion`);
  }

  // Every declared criterion must be covered by at least one item.
  console.log();
  const declared = (state.mandateDocument.acceptanceCriteria as Array<{ id: string }>).map((c) => c.id);
  const covered = new Set(items.flatMap((i) => (i.criteria ?? i.supports ?? []) as string[]));
  for (const id of declared) {
    const ok = covered.has(id);
    console.log(`  criterion ${id} covered by an artifact or evidence item: ${ok}`);
    if (!ok) failures.push(`criterion ${id} has nothing mapped to it`);
  }

  // The evidence bundle itself must be published and readable.
  console.log();
  const evidenceSha = state.evidenceCommitSha as string;
  const bundle = [
    `https://raw.githubusercontent.com/${repo}/${evidenceSha}/EVIDENCE.md`,
    `https://raw.githubusercontent.com/${repo}/${evidenceSha}/evidence/judgment.json`,
    `https://raw.githubusercontent.com/${repo}/${evidenceSha}/evidence/onchain.json`,
    `https://raw.githubusercontent.com/${repo}/${evidenceSha}/evidence/delivery-manifest.json`,
    `https://raw.githubusercontent.com/${repo}/${evidenceSha}/evidence/mandate.json`,
  ];
  for (const url of bundle) {
    const response = await fetch(url, { cache: "no-store" });
    const name = url.split(`${evidenceSha}/`)[1];
    console.log(`  ${name.padEnd(34)} HTTP ${response.status}`);
    if (!response.ok) failures.push(`evidence bundle file ${name} returned HTTP ${response.status}`);
  }

  // The published judgment must be the judgment the Court holds, not a retelling.
  const publishedJudgment = await fetch(`https://raw.githubusercontent.com/${repo}/${evidenceSha}/evidence/judgment.json`, { cache: "no-store" }).then((r) => r.json() as Promise<Record<string, any>>);
  const live = record.judgment as Record<string, any>;
  console.log();
  for (const field of ["verdict", "settlementBps", "confidenceBps"] as const) {
    const same = JSON.stringify(publishedJudgment[field]) === JSON.stringify(live[field]);
    console.log(`  published judgment.${field} matches the Court: ${same} (${JSON.stringify(live[field])})`);
    if (!same) failures.push(`published judgment.${field} is ${JSON.stringify(publishedJudgment[field])} but the Court holds ${JSON.stringify(live[field])}`);
  }

  console.log();
  if (failures.length) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("GATE G5 PASS");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
