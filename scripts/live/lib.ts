// Shared helpers for the live end-to-end run against production.
//
// Run state (including throwaway testnet private keys) is persisted under
// .runs/, which is gitignored. Nothing here is a production credential: the
// principal and provider wallets are generated per run and funded with a few
// test USDC from the court signer.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createPublicClient, createWalletClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";

export const REPO_ROOT = "/home/sudodave/mandate-court";
export const RUNS_DIR = join(REPO_ROOT, ".runs");
export const BASE_URL = process.env.MANDATE_COURT_URL ?? "https://mandate-court.vercel.app";
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

export const USDC_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "nonces", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export function envFile(path = join(REPO_ROOT, ".env.build")) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)] as const;
      }),
  ) as Record<string, string>;
}

export const publicClient = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });

export function walletFor(privateKey: string) {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return { account, client: createWalletClient({ account, chain: baseSepolia, transport: http("https://sepolia.base.org") }) };
}

export function newWallet() {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

export async function usdcBalance(address: string) {
  return (await publicClient.readContract({ address: USDC, abi: USDC_ABI, functionName: "balanceOf", args: [address as `0x${string}`] })) as bigint;
}

export function usdc(atomic: bigint | string) {
  return `${formatUnits(BigInt(atomic), 6)} USDC`;
}

export function sha256Hex(bytes: Uint8Array | Buffer | string) {
  return `0x${createHash("sha256").update(bytes as never).digest("hex")}`;
}

// ---------------------------------------------------------------- run state

export type RunState = Record<string, unknown>;

export function statePath(runId: string) {
  return join(RUNS_DIR, runId, "state.json");
}

export function loadState(runId: string): RunState {
  const path = statePath(runId);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RunState) : {};
}

export function saveState(runId: string, patch: RunState) {
  const path = statePath(runId);
  mkdirSync(dirname(path), { recursive: true });
  const next = { ...loadState(runId), ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function currentRunId() {
  const pointer = join(RUNS_DIR, "current");
  if (process.env.RUN_ID) return process.env.RUN_ID;
  if (existsSync(pointer)) return readFileSync(pointer, "utf8").trim();
  throw new Error("No current run. Set RUN_ID or create .runs/current");
}

export function setCurrentRunId(runId: string) {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(join(RUNS_DIR, "current"), `${runId}\n`);
}

// ------------------------------------------------------------- http helpers

export type ApiResult = { status: number; body: unknown };

export async function api(path: string, init: RequestInit & { apiKey?: string } = {}): Promise<ApiResult> {
  const { apiKey, ...rest } = init;
  const response = await fetch(`${BASE_URL}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

export function must(result: ApiResult, what: string) {
  if (result.status >= 400) throw new Error(`${what} -> ${result.status} ${JSON.stringify(result.body).slice(0, 600)}`);
  return result.body as never;
}

export function log(...parts: unknown[]) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
