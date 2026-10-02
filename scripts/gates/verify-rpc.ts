// G2 oracle. Proves Base Sepolia reads go through one shared multi-endpoint
// transport with working failover, and that no application module still builds
// its own single-URL transport.
//
// Three things are checked, and the third is the one that matters:
//   1. No module under apps/web constructs http(BASE_SEPOLIA_RPC_URL) itself.
//   2. Every endpoint configured on Vercel production independently passes the
//      five-call probe, including eth_getLogs, which some endpoints refuse while
//      answering a liveness ping.
//   3. Failover actually works: a client whose first endpoint is a black hole
//      still completes a read. Without this, a fallback list is decoration.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, fallback, http, parseAbiItem } from "viem";
import { baseSepolia } from "viem/chains";
import { PROJECT_ID, vercel } from "../vercel-api";

const REPO = "/home/sudodave/mandate-court";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const BALANCE_OF = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const PROBE_WALLET = "0x881e422CB848814e9CCe35E38364d00fa8D84Fae" as const;
const KNOWN_TX = "0x27270a1264fe2164a0c9bcc15b781641e8e5cf7707b3f464706e91e4fb11af81" as const;
// Routable but closed, so a connection attempt fails fast rather than hanging.
const DEAD_ENDPOINT = "http://127.0.0.1:9";

function tracked() {
  return execFileSync("git", ["ls-files", "apps/web"], { cwd: REPO, encoding: "utf8" }).trim().split("\n").filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"));
}

async function probe(url: string) {
  const notes: string[] = [];
  const client = createPublicClient({ chain: baseSepolia, transport: http(url, { timeout: 12_000, retryCount: 0 }) });
  try {
    if ((await client.getChainId()) !== 84532) notes.push("wrong chainId");
  } catch (e) { notes.push(`chainId failed`); return notes; }
  let head = 0n;
  try { head = await client.getBlockNumber(); } catch { notes.push("blockNumber failed"); }
  try { await client.readContract({ address: USDC, abi: BALANCE_OF, functionName: "balanceOf", args: [PROBE_WALLET] }); } catch { notes.push("eth_call failed"); }
  try {
    const r = await client.getTransactionReceipt({ hash: KNOWN_TX });
    if (r.status !== "success") notes.push("known tx not success");
  } catch { notes.push("getTransactionReceipt failed"); }
  try { if (head) await client.getLogs({ address: USDC, event: TRANSFER, fromBlock: head - 200n, toBlock: head }); } catch { notes.push("eth_getLogs failed"); }
  return notes;
}

async function main() {
  const failures: string[] = [];

  // --- 1. the shared module exists and nothing bypasses it ----------------
  const sharedPath = join(REPO, "apps/web/lib/base-rpc.ts");
  const shared = readFileSync(sharedPath, "utf8");
  if (!shared.includes("fallback(")) failures.push("apps/web/lib/base-rpc.ts does not use viem's fallback transport");
  console.log("shared transport        apps/web/lib/base-rpc.ts uses fallback()");

  const offenders: string[] = [];
  for (const file of tracked()) {
    if (file === "apps/web/lib/base-rpc.ts") continue;
    const text = readFileSync(join(REPO, file), "utf8");
    // A single-URL transport built from the env var, in any spelling.
    if (/http\(\s*(rpc|process\.env\.BASE_SEPOLIA_RPC_URL)/.test(text)) offenders.push(file);
  }
  console.log(`modules bypassing it   ${offenders.length ? offenders.join(", ") : "none"}`);
  if (offenders.length) failures.push(`${offenders.length} module(s) still build a single-URL transport: ${offenders.join(", ")}`);

  // --- 2. every endpoint production is configured with is healthy --------
  console.log();
  const { envs } = (await vercel(`/v10/projects/${PROJECT_ID}/env?decrypt=true`)) as { envs: Array<{ key: string; value?: string; target?: string[]; type: string }> };
  const row = envs.find((e) => e.key === "BASE_SEPOLIA_RPC_URLS" && (e.target ?? []).includes("production"));
  if (!row) failures.push("BASE_SEPOLIA_RPC_URLS is not set on Vercel production");
  const configured = (row?.value ?? "").split(",").map((u) => u.trim()).filter((u) => u.startsWith("http"));
  console.log(`production endpoints   ${configured.length}`);
  if (configured.length < 2) failures.push(`production declares ${configured.length} endpoint(s); failover needs at least 2`);

  for (const url of configured) {
    const notes = await probe(url);
    console.log(`  ${notes.length === 0 ? "ok  " : "FAIL"} ${url}${notes.length ? `  (${notes.join("; ")})` : ""}`);
    if (notes.length) failures.push(`${url} failed the probe: ${notes.join("; ")}`);
  }

  // --- 3. failover demonstrably works -----------------------------------
  console.log();
  const failingFirst = createPublicClient({
    chain: baseSepolia,
    transport: fallback(
      [http(DEAD_ENDPOINT, { timeout: 2_000, retryCount: 0 }), ...configured.map((u) => http(u, { timeout: 15_000, retryCount: 1 }))],
      { rank: false, retryCount: 1 },
    ),
  });
  let recovered = false;
  try {
    const balance = await failingFirst.readContract({ address: USDC, abi: BALANCE_OF, functionName: "balanceOf", args: [PROBE_WALLET] });
    recovered = typeof balance === "bigint";
    console.log(`failover with a dead primary: read succeeded (${balance} atomic)`);
  } catch (error) {
    console.log(`failover with a dead primary: FAILED (${String(error).split("\n")[0].slice(0, 90)})`);
  }
  if (!recovered) failures.push("a client whose first endpoint is dead could not complete a read, so failover is not working");

  // Positive control: the dead endpoint alone must fail, otherwise the test above proves nothing.
  const deadOnly = createPublicClient({ chain: baseSepolia, transport: http(DEAD_ENDPOINT, { timeout: 2_000, retryCount: 0 }) });
  let deadFailed = false;
  try {
    await deadOnly.getChainId();
  } catch {
    deadFailed = true;
  }
  console.log(`control: the dead endpoint alone fails: ${deadFailed}`);
  if (!deadFailed) failures.push(`${DEAD_ENDPOINT} unexpectedly answered, so the failover test had no real failure to recover from`);

  console.log();
  if (failures.length) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("GATE G2 PASS");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
