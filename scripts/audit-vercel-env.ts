// Read-only audit of the Vercel project's environment variables against what
// apps/web/lib/env.ts requires and what .env.build declares. Prints presence
// and target environments only, never decrypted values.
import { readFileSync } from "node:fs";
import { PROJECT_ID, PROJECT_NAME, vercel } from "./vercel-api";

type EnvRow = { id: string; key: string; type: string; target?: string[]; gitBranch?: string | null; createdAt?: number; updatedAt?: number };

function parseEnvFile(path: string) {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)] as const;
      }),
  );
}

async function main() {
  const local = parseEnvFile("/home/sudodave/mandate-court/.env.build");
  const example = parseEnvFile("/home/sudodave/mandate-court/.env.example");
  const { envs } = (await vercel(`/v10/projects/${PROJECT_ID}/env?decrypt=false`)) as { envs: EnvRow[] };

  console.log(`project: ${PROJECT_NAME} (${PROJECT_ID})`);
  console.log(`remote env vars: ${envs.length}`);
  console.log();

  const remote = new Map<string, EnvRow[]>();
  for (const row of envs) {
    if (!remote.has(row.key)) remote.set(row.key, []);
    remote.get(row.key)!.push(row);
  }

  const keys = [...new Set([...Object.keys(example), ...Object.keys(local), ...remote.keys()])].sort();
  console.log("KEY".padEnd(36), "VERCEL TARGETS".padEnd(34), "LOCAL", " EXAMPLE");
  console.log("-".repeat(96));
  const missingOnVercel: string[] = [];
  const missingLocally: string[] = [];
  for (const key of keys) {
    const rows = remote.get(key) ?? [];
    const targets = rows.length ? rows.map((r) => (r.target ?? []).join("+")).join(" | ") : "-- ABSENT --";
    const inLocal = key in local ? "yes" : "no";
    const inExample = key in example ? "yes" : "no";
    console.log(key.padEnd(36), targets.padEnd(34), inLocal.padEnd(5), inExample);
    if (!rows.length) missingOnVercel.push(key);
    if (!(key in local) && key in example) missingLocally.push(key);
  }

  console.log();
  console.log("absent on Vercel:", missingOnVercel.length ? missingOnVercel.join(", ") : "(none)");
  console.log("absent in .env.build but in .env.example:", missingLocally.length ? missingLocally.join(", ") : "(none)");

  // Placeholders that were never replaced.
  const placeholders = Object.entries(local).filter(([, v]) => v.includes("replace-with") || v === "0x" || v === "");
  console.log();
  console.log("placeholder / empty in .env.build:", placeholders.length ? placeholders.map(([k]) => k).join(", ") : "(none)");

  // Production deployments, to see whether the pushed commits ever shipped.
  const deployments = (await vercel(`/v6/deployments?projectId=${PROJECT_ID}&target=production&limit=5`)) as {
    deployments: Array<{ uid: string; state: string; created: number; meta?: Record<string, string>; url: string }>;
  };
  console.log();
  console.log("recent production deployments:");
  for (const d of deployments.deployments) {
    const sha = (d.meta?.githubCommitSha ?? "").slice(0, 7) || "(no sha)";
    console.log(`  ${new Date(d.created).toISOString()}  ${d.state.padEnd(10)} ${sha}  ${d.url}`);
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
