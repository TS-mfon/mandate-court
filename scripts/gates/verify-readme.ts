// G6 oracle. Proves the README carries an evidence section whose links all
// resolve, covering the agent work, the court's resolution, and the payment
// release.
//
// Every http(s) link inside the section is fetched. A link that 404s, or a
// section that silently loses one of the three required kinds of evidence,
// fails the gate. The on-chain claims are additionally checked against the
// chain rather than trusted from the prose: each transaction hash cited must be
// a confirmed success, and the settlement hash must be the one the Court holds.
import { readFileSync } from "node:fs";
import { api, currentRunId, loadState, publicClient, sleep } from "../live/lib";

const SECTION = "## Verified Live Run";

async function main() {
  const failures: string[] = [];
  const state = loadState(currentRunId()) as Record<string, any>;
  const readme = readFileSync("/home/sudodave/mandate-court/README.md", "utf8");

  // --- the section exists and is reachable from the table of contents -----
  if (!readme.includes(SECTION)) throw new Error(`README has no "${SECTION}" section`);
  if (!readme.includes("[Verified Live Run](#verified-live-run)")) failures.push("the table of contents does not link to the Verified Live Run section");

  const start = readme.indexOf(SECTION);
  const nextHeading = readme.indexOf("\n## ", start + SECTION.length);
  const section = readme.slice(start, nextHeading === -1 ? undefined : nextHeading);
  console.log(`section is ${section.length} characters\n`);

  // --- it must cover all three things the user asked to be linked --------
  const required: Array<[string, RegExp]> = [
    ["the agent's work", new RegExp(state.deliveryRepo.replace("/", "\\/"))],
    ["the evidence write-up", /EVIDENCE\.md/],
    ["the court's resolution", /explorer\/MC_|\/api\/v1\/cases\/MC_/],
    ["the judgment verdict", /FULFILLED/],
    ["the payment release", new RegExp(state.settlementTxHash.slice(2, 10))],
  ];
  for (const [label, pattern] of required) {
    const ok = pattern.test(section);
    console.log(`  covers ${label.padEnd(24)} ${ok}`);
    if (!ok) failures.push(`the evidence section does not cover ${label}`);
  }

  // --- every link in the section must resolve ----------------------------
  //
  // Block explorers sit behind bot protection and answer 403 or drop the
  // connection for automated clients, which is not evidence that the link is
  // broken. For an explorer transaction link the stronger check is available
  // directly: resolve the hash in the URL against the chain. A 403 is accepted
  // only when the hash it points at is a confirmed transaction, so a typo or a
  // fabricated hash still fails. Any other host, and any 404, fails outright.
  console.log();
  const EXPLORER_TX = /^https:\/\/(sepolia\.)?basescan\.org\/tx\/(0x[0-9a-f]{64})$/;
  const urls = [...new Set([...section.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]))];
  console.log(`${urls.length} distinct link(s) in the section`);
  for (const url of urls) {
    const explorer = EXPLORER_TX.exec(url);
    let status = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url, { cache: "no-store", redirect: "follow" });
        status = response.status;
        if (response.ok) break;
      } catch {
        status = -1;
      }
      if (attempt < 3) await sleep(2_000);
    }
    const reachable = status >= 200 && status < 400;

    if (reachable) {
      console.log(`  ok    ${status}  ${url.length > 94 ? `${url.slice(0, 91)}...` : url}`);
      continue;
    }

    if (explorer && (status === 403 || status === 429 || status === -1)) {
      const hash = explorer[2] as `0x${string}`;
      const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
      const confirmed = receipt?.status === "success";
      console.log(`  ${confirmed ? "ok   " : "FAIL "} explorer blocked automation (${status === -1 ? "network" : status}); hash ${confirmed ? `confirmed in block ${receipt?.blockNumber}` : "NOT CONFIRMED ON CHAIN"}  ${hash.slice(0, 14)}…`);
      if (!confirmed) failures.push(`${url} is unreachable and the hash it cites is not a confirmed Base Sepolia transaction`);
      continue;
    }

    console.log(`  FAIL  ${status === -1 ? "network" : status}  ${url.length > 94 ? `${url.slice(0, 91)}...` : url}`);
    failures.push(`${url} returned ${status === -1 ? "a network error" : status}`);
  }

  // --- the cited transactions must be real -------------------------------
  console.log();
  const hashes = [...new Set([...section.matchAll(/0x[0-9a-f]{64}/g)].map((m) => m[0]))];
  console.log(`${hashes.length} transaction hash(es) cited`);
  let confirmed = 0;
  for (const hash of hashes) {
    const receipt = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null);
    if (!receipt) {
      // Not every 64-hex value is a transaction: the judgment hash and the
      // GenLayer transaction id are also cited, and neither is on Base.
      console.log(`  not a Base Sepolia tx (expected for judgment/GenLayer hashes): ${hash.slice(0, 14)}…`);
      continue;
    }
    confirmed += 1;
    const ok = receipt.status === "success";
    console.log(`  ${ok ? "success" : "REVERTED"}  block ${receipt.blockNumber}  ${hash.slice(0, 14)}…`);
    if (!ok) failures.push(`cited transaction ${hash} is not a successful Base Sepolia transaction`);
  }
  console.log(`${confirmed} of the cited hashes are confirmed Base Sepolia transactions`);
  if (confirmed < 7) failures.push(`only ${confirmed} confirmed transactions are cited; the lifecycle has 7 stages`);

  // --- the settlement hash in the README must be the Court's -------------
  console.log();
  const res = await api(`/api/v1/cases/${state.mandateId}`, { apiKey: state.providerApiKey as string });
  const record = ((res.body as { case?: unknown }).case ?? res.body) as Record<string, any>;
  const live = String(record.settlementTransactionHash);
  const cited = section.includes(live);
  console.log(`README cites the Court's settlement transaction: ${cited} (${live.slice(0, 14)}…)`);
  if (!cited) failures.push(`the README does not cite the settlement transaction the Court holds (${live})`);

  const verdictMatches = section.includes(String(record.judgment.verdict)) && section.includes(String(record.judgment.settlementBps));
  console.log(`README's verdict and settlementBps match the Court: ${verdictMatches}`);
  if (!verdictMatches) failures.push("the README's verdict or settlementBps does not match the Court's judgment");

  console.log();
  if (failures.length) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("GATE G6 PASS");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
