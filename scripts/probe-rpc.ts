// Probes candidate Base Sepolia RPC endpoints. The public sepolia.base.org
// endpoint dropped a connection and returned 403 during the live run, so the
// production config needs an endpoint that holds up, plus failover.
//
// Each candidate is judged on four things, not just liveness: correct chainId,
// a fresh head block, a real eth_call against USDC, and the eth_getLogs the
// settlement verification depends on. An endpoint that answers eth_blockNumber
// but refuses eth_getLogs is useless here.
import { createPublicClient, http, parseAbiItem } from "viem";
import { baseSepolia } from "viem/chains";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const BALANCE_OF = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const PROBE_WALLET = "0x881e422CB848814e9CCe35E38364d00fa8D84Fae" as const;
// A known-good settlement transaction from the verified live run.
const KNOWN_TX = "0x27270a1264fe2164a0c9bcc15b781641e8e5cf7707b3f464706e91e4fb11af81" as const;

const CANDIDATES: Array<[string, string]> = [
  ["base.org (current)", "https://sepolia.base.org"],
  ["publicnode", "https://base-sepolia-rpc.publicnode.com"],
  ["drpc", "https://base-sepolia.drpc.org"],
  ["1rpc", "https://1rpc.io/base-sepolia"],
  ["tenderly", "https://base-sepolia.gateway.tenderly.co"],
  ["blockpi", "https://base-sepolia.blockpi.network/v1/rpc/public"],
  ["blastapi", "https://base-sepolia.public.blastapi.io"],
  ["therpc", "https://base-sepolia.therpc.io"],
];

type Result = { label: string; url: string; ok: boolean; notes: string[]; ms: number; head?: bigint };

async function probe(label: string, url: string): Promise<Result> {
  const notes: string[] = [];
  const started = Date.now();
  const client = createPublicClient({ chain: baseSepolia, transport: http(url, { timeout: 12_000, retryCount: 0 }) });
  let ok = true;
  let head: bigint | undefined;

  try {
    const id = await client.getChainId();
    if (id !== 84532) { notes.push(`WRONG CHAIN ${id}`); ok = false; }
  } catch (error) {
    notes.push(`chainId: ${short(error)}`);
    return { label, url, ok: false, notes, ms: Date.now() - started };
  }

  try {
    head = await client.getBlockNumber();
  } catch (error) {
    notes.push(`blockNumber: ${short(error)}`);
    ok = false;
  }

  try {
    await client.readContract({ address: USDC, abi: BALANCE_OF, functionName: "balanceOf", args: [PROBE_WALLET] });
  } catch (error) {
    notes.push(`eth_call: ${short(error)}`);
    ok = false;
  }

  try {
    const receipt = await client.getTransactionReceipt({ hash: KNOWN_TX });
    if (receipt.status !== "success") { notes.push("known tx not success"); ok = false; }
  } catch (error) {
    notes.push(`getTransactionReceipt: ${short(error)}`);
    ok = false;
  }

  // eth_getLogs over a narrow range; many free endpoints cap or refuse this.
  try {
    if (head) {
      await client.getLogs({ address: USDC, event: TRANSFER, fromBlock: head - 200n, toBlock: head });
    }
  } catch (error) {
    notes.push(`eth_getLogs: ${short(error)}`);
    ok = false;
  }

  return { label, url, ok, notes, ms: Date.now() - started, head };
}

function short(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0].slice(0, 70);
}

async function main() {
  const results = await Promise.all(CANDIDATES.map(([label, url]) => probe(label, url)));
  const heads = results.filter((r) => r.head).map((r) => r.head!);
  const best = heads.length ? heads.reduce((a, b) => (a > b ? a : b)) : 0n;

  console.log("label              ok    ms   head        lag  notes");
  console.log("-".repeat(104));
  for (const r of results.sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms)) {
    const lag = r.head ? String(best - r.head) : "-";
    console.log(
      `${r.label.padEnd(18)} ${(r.ok ? "yes" : "NO ").padEnd(5)} ${String(r.ms).padStart(5)} ${String(r.head ?? "-").padStart(11)} ${lag.padStart(4)}  ${r.notes.join("; ")}`,
    );
  }
  const healthy = results.filter((r) => r.ok);
  console.log();
  console.log(`${healthy.length} of ${results.length} candidates passed all five checks`);
  console.log("healthy, fastest first:");
  for (const r of healthy.sort((a, b) => a.ms - b.ms)) console.log(`  ${r.ms.toString().padStart(5)}ms  ${r.url}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
