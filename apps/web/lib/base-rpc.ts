import { createPublicClient, fallback, http } from "viem";
import { baseSepolia } from "viem/chains";

/**
 * Shared Base Sepolia transport.
 *
 * Every read used to build its own `http(process.env.BASE_SEPOLIA_RPC_URL)`, which made
 * the public endpoint a single point of failure: during the v0.2 live run it answered
 * `eth_blockNumber` and then dropped a connection mid-read. viem's `fallback` transport
 * ranks the endpoints and moves on when one errors, so a flaky endpoint costs a retry
 * rather than a failed relay.
 *
 * Configuration, in order of precedence:
 *   BASE_SEPOLIA_RPC_URLS  comma-separated list, used in the order given
 *   BASE_SEPOLIA_RPC_URL   single endpoint, still honoured, tried first
 * Any endpoint named by either variable is used ahead of the built-in defaults, and the
 * defaults are appended so there is always more than one route to the chain.
 *
 * The defaults are the endpoints that passed `pnpm probe:rpc`, which checks chainId, head
 * block, `eth_call`, `eth_getTransactionReceipt`, and `eth_getLogs`. Endpoints that answer
 * a liveness ping but refuse `eth_getLogs` are deliberately excluded: settlement
 * verification needs log decoding, so such an endpoint would fail later and less visibly.
 */
export const DEFAULT_BASE_SEPOLIA_RPCS = [
  "https://base-sepolia-rpc.publicnode.com",
  "https://sepolia.base.org",
  "https://base-sepolia.gateway.tenderly.co",
] as const;

export function baseSepoliaRpcUrls() {
  const configured = [
    ...(process.env.BASE_SEPOLIA_RPC_URLS ?? "").split(","),
    process.env.BASE_SEPOLIA_RPC_URL ?? "",
  ]
    .map((url) => url.trim())
    .filter((url) => url.startsWith("http"));

  // Preserve configured order, then append any default not already present.
  const ordered = [...configured];
  for (const url of DEFAULT_BASE_SEPOLIA_RPCS) {
    if (!ordered.includes(url)) ordered.push(url);
  }
  return ordered;
}

let cached: ReturnType<typeof build> | undefined;
let cachedKey = "";

function build(urls: string[]) {
  return createPublicClient({
    chain: baseSepolia,
    transport: fallback(
      urls.map((url) => http(url, { timeout: 15_000, retryCount: 1, retryDelay: 400 })),
      { rank: false, retryCount: 1 },
    ),
  });
}

/**
 * A Base Sepolia public client with failover. Cached per resolved endpoint list so repeated
 * calls in one lambda invocation reuse the same transport.
 */
export function baseSepoliaClient() {
  const urls = baseSepoliaRpcUrls();
  const key = urls.join("|");
  if (cached && cachedKey === key) return cached;
  cachedKey = key;
  cached = build(urls);
  return cached;
}

/** Test seam: drop the memoised client so a changed environment is picked up. */
export function resetBaseSepoliaClient() {
  cached = undefined;
  cachedKey = "";
}
