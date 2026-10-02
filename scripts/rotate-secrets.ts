// Rotates the deployment secrets on Vercel and fills the gaps found by
// scripts/audit-vercel-env.ts, then mirrors the new values into .env.build.
//
// Values are generated locally from randomBytes(32) and never printed. Each key
// is replaced by deleting every existing entry for it and creating one entry
// covering production, preview, and development, so the three environments
// cannot silently drift apart.
//
// WEBHOOK_ENCRYPTION_KEY is set here for the first time. That is only safe
// because no agent webhook secret exists yet: AES-GCM authenticates on decrypt,
// so introducing a distinct key after secrets were issued under the
// API_KEY_PEPPER fallback would make them undecryptable. Verified with a
// countDocuments on agents holding a ciphertext before running this.
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { PROJECT_ID, PROJECT_NAME, vercel } from "./vercel-api";

const TARGETS = ["production", "preview", "development"];
const GITHUB_REPO = "TS-mfon/mandate-court";

// Secrets that a consumer outside Vercel also holds, and must be updated in the
// same breath. CRON_SECRET is read by the GitHub Actions schedule that drives
// the queue processor: rotating it on Vercel alone silently breaks that cron,
// which is exactly what happened on 2026-09-30 and went unnoticed for two days
// because the processor was being driven by hand at the time.
const GITHUB_MIRRORED = ["CRON_SECRET"];

// Rotated because the user asked for fresh values.
const ROTATE = ["API_KEY_PEPPER", "WEBHOOK_SIGNING_SECRET", "CRON_SECRET"];
// Absent in production; filling a real gap rather than rotating.
const CREATE_SECRET = ["WEBHOOK_ENCRYPTION_KEY"];
// Non-secret configuration that was missing from .env.build.
const PLAIN: Record<string, string> = { GENLAYER_RESEARCH_DATA_V2_ENABLED: "true" };

type EnvRow = { id: string; key: string; target?: string[]; type: string };

function secret() {
  return randomBytes(32).toString("base64");
}

function setGithubSecret(key: string, value: string) {
  execFileSync("gh", ["secret", "set", key, "--repo", GITHUB_REPO], { input: value, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

async function replace(key: string, value: string, type: "sensitive" | "encrypted" | "plain") {
  const { envs } = (await vercel(`/v10/projects/${PROJECT_ID}/env?decrypt=false`)) as { envs: EnvRow[] };
  const existing = envs.filter((e) => e.key === key);
  for (const row of existing) {
    await vercel(`/v9/projects/${PROJECT_ID}/env/${row.id}`, { method: "DELETE" });
  }
  await vercel(`/v10/projects/${PROJECT_ID}/env`, {
    method: "POST",
    body: JSON.stringify({ key, value, type, target: TARGETS }),
  });
  return existing.length;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`project: ${PROJECT_NAME} (${PROJECT_ID})`);
  console.log(`mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log();

  const generated: Record<string, string> = {};
  for (const key of [...ROTATE, ...CREATE_SECRET]) generated[key] = secret();
  for (const [key, value] of Object.entries(PLAIN)) generated[key] = value;

  if (dryRun) {
    for (const key of Object.keys(generated)) {
      const kind = ROTATE.includes(key) ? "rotate" : CREATE_SECRET.includes(key) ? "create (was absent)" : "set (config)";
      const mirror = GITHUB_MIRRORED.includes(key) ? `, and mirror to GitHub secret on ${GITHUB_REPO}` : "";
      console.log(`  ${key.padEnd(34)} ${kind}${mirror}`);
    }
    console.log("\nnothing written.");
    return;
  }

  // Back up .env.build before touching anything.
  const envPath = "/home/sudodave/mandate-court/.env.build";
  const backup = `${envPath}.bak-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`;
  copyFileSync(envPath, backup);
  console.log(`backed up .env.build -> ${backup.split("/").pop()}`);
  console.log();

  for (const key of [...ROTATE, ...CREATE_SECRET]) {
    const replaced = await replace(key, generated[key], "sensitive");
    const kind = ROTATE.includes(key) ? "rotated" : "created";
    console.log(`  ${key.padEnd(34)} ${kind}, replaced ${replaced} prior entr${replaced === 1 ? "y" : "ies"}, targets ${TARGETS.join("+")}`);
  }

  // Mirror to every other holder of the same secret, or the next rotation
  // breaks them silently.
  for (const key of GITHUB_MIRRORED) {
    if (!(key in generated)) continue;
    setGithubSecret(key, generated[key]);
    console.log(`  ${key.padEnd(34)} mirrored to GitHub Actions secret on ${GITHUB_REPO}`);
  }
  for (const [key, value] of Object.entries(PLAIN)) {
    const replaced = await replace(key, value, "plain");
    console.log(`  ${key.padEnd(34)} set to ${value}, replaced ${replaced} prior entr${replaced === 1 ? "y" : "ies"}, targets ${TARGETS.join("+")}`);
  }

  // Mirror into .env.build so local tooling and the next deploy agree.
  let text = readFileSync(envPath, "utf8");
  for (const [key, value] of Object.entries(generated)) {
    text = new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
  }
  writeFileSync(envPath, text.endsWith("\n") ? text : `${text}\n`);
  console.log();
  console.log(".env.build updated (values not printed)");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
