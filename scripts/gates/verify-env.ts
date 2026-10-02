// G1 oracle. Proves every environment variable the running application reads is
// either present on Vercel production or provably optional, and that no
// required value is still a placeholder.
//
// The key list is discovered from the source rather than hand-maintained: every
// process.env.X reference under apps/web is collected, then classified against
// the zod schema in apps/web/lib/env.ts. A hand-written list would pass while
// silently missing a newly added variable.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "viem";
import { PROJECT_ID, vercel } from "../vercel-api";

const REPO = "/home/sudodave/mandate-court";
const WEB = join(REPO, "apps/web");

// Provided by the platform, never configured by us.
const PLATFORM = new Set(["NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_REGION", "CI", "NEXT_RUNTIME", "npm_lifecycle_event"]);

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(path)) out.push(path);
  }
  return out;
}

function parseEnvFile(path: string) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trimStart().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)] as const;
      }),
  ) as Record<string, string>;
}

type EnvRow = { key: string; target?: string[]; type: string };

async function main() {
  const failures: string[] = [];

  // 1. Discover every env key the application actually reads.
  const referenced = new Set<string>();
  for (const file of walk(WEB)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) referenced.add(m[1]);
    for (const m of text.matchAll(/process\.env\[["'`]([A-Z0-9_]+)["'`]\]/g)) referenced.add(m[1]);
  }
  // 2. Anything the zod schema names is also read, via env().
  const schemaText = readFileSync(join(WEB, "lib/env.ts"), "utf8");
  const schemaKeys = new Set<string>();
  for (const m of schemaText.matchAll(/^\s{2}([A-Z0-9_]+):\s*z\./gm)) {
    schemaKeys.add(m[1]);
    referenced.add(m[1]);
  }
  // Required = in the schema and not .optional() and without a .default().
  const required = new Set<string>();
  for (const key of schemaKeys) {
    const line = schemaText.split("\n").find((l) => l.trimStart().startsWith(`${key}:`)) ?? "";
    if (!line.includes(".optional()") && !line.includes(".default(")) required.add(key);
  }

  for (const key of PLATFORM) referenced.delete(key);

  // 3. What Vercel actually has.
  const { envs } = (await vercel(`/v10/projects/${PROJECT_ID}/env?decrypt=false`)) as { envs: EnvRow[] };
  const onProduction = new Set(envs.filter((e) => (e.target ?? []).includes("production")).map((e) => e.key));

  const local = parseEnvFile(join(REPO, ".env.build"));

  console.log(`env keys read by apps/web : ${referenced.size}`);
  console.log(`declared in env.ts schema : ${schemaKeys.size} (required: ${[...required].sort().join(", ") || "none"})`);
  console.log(`present on Vercel production: ${onProduction.size}`);
  console.log();

  // 4. Required keys must be on production.
  for (const key of [...required].sort()) {
    const ok = onProduction.has(key);
    console.log(`  required  ${key.padEnd(34)} ${ok ? "present" : "MISSING ON PRODUCTION"}`);
    if (!ok) failures.push(`${key} is required by env.ts but absent from Vercel production`);
  }

  // 5. Every other referenced key must be accounted for: present on production,
  //    declared empty locally (a deliberately unconfigured integration), or
  //    given an identical default in the source, which makes absence equivalent
  //    to presence.
  console.log();
  const sources = walk(WEB).map((f) => readFileSync(f, "utf8")).join("\n");
  function codeDefault(key: string) {
    const pattern = new RegExp(`process\\.env\\.${key}\\s*(?:\\|\\||\\?\\?)\\s*["'\`]([^"'\`]*)["'\`]`);
    return pattern.exec(sources)?.[1];
  }

  const optionalAbsent: string[] = [];
  const defaulted: string[] = [];
  for (const key of [...referenced].filter((k) => !required.has(k)).sort()) {
    if (onProduction.has(key)) continue;
    const localValue = local[key];
    if (localValue !== undefined && localValue.trim() === "") {
      optionalAbsent.push(key);
      continue;
    }
    const fallback = codeDefault(key);
    if (fallback !== undefined && fallback === localValue) {
      defaulted.push(`${key} (code default matches .env.build)`);
      continue;
    }
    console.log(`  optional  ${key.padEnd(34)} ABSENT on production, non-empty locally, and no matching code default`);
    failures.push(`${key} is read by apps/web, absent on Vercel, non-empty in .env.build, and has no identical code default`);
  }
  console.log(`  deliberately unconfigured: ${optionalAbsent.join(", ") || "(none)"}`);
  console.log(`  absent but code-defaulted: ${defaulted.join(", ") || "(none)"}`);

  // 6. No placeholder left in any value we control.
  console.log();
  const placeholders = Object.entries(local).filter(([, v]) => v.includes("replace-with") || v === "0x");
  if (placeholders.length) {
    for (const [k] of placeholders) {
      console.log(`  placeholder still present in .env.build: ${k}`);
      failures.push(`${k} still holds a placeholder value`);
    }
  } else {
    console.log("  no placeholder or bare 0x values remain in .env.build");
  }

  // 7. The USDC address must be a valid EIP-55 checksum, since a wrong one
  //    silently breaks EIP-3009 funding.
  const usdcOk = (() => {
    try {
      return getAddress(local.BASE_USDC_ADDRESS.toLowerCase()) === local.BASE_USDC_ADDRESS;
    } catch {
      return false;
    }
  })();
  console.log(`  BASE_USDC_ADDRESS is valid EIP-55: ${usdcOk}`);
  if (!usdcOk) failures.push("BASE_USDC_ADDRESS is not a correctly checksummed address");

  console.log();
  if (failures.length) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("GATE G1 PASS");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
