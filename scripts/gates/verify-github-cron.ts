// G3 oracle. Proves a GitHub Actions schedule really drives the queue
// processor.
//
// A committed workflow file proves nothing: the previous workflow was committed,
// active, and scheduled, and still failed on every run for two days because a
// secret rotation left it holding a stale CRON_SECRET. So this gate requires a
// run that actually concluded successfully, dispatched from the current
// workflow, plus the secret and the schedule that make the unattended path work.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/sudodave/mandate-court";
const SLUG = "TS-mfon/mandate-court";
const WORKFLOW = "process-queue.yml";

function gh(args: string[]) {
  return execFileSync("gh", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 }).trim();
}

function git(args: string[]) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();
}

async function main() {
  const failures: string[] = [];

  // --- 1. the workflow is committed, registered, and active --------------
  const tracked = git(["ls-files", ".github/workflows"]).split("\n").filter(Boolean);
  console.log(`tracked workflows      ${tracked.join(", ") || "none"}`);
  if (!tracked.includes(`.github/workflows/${WORKFLOW}`)) failures.push(`.github/workflows/${WORKFLOW} is not tracked by git`);

  const workflows = JSON.parse(gh(["api", `repos/${SLUG}/actions/workflows`])) as { workflows: Array<{ name: string; path: string; state: string; id: number }> };
  const mine = workflows.workflows.find((w) => w.path === `.github/workflows/${WORKFLOW}`);
  console.log(`registered with GitHub ${mine ? `${mine.name} (state=${mine.state})` : "NO"}`);
  if (!mine) failures.push(`${WORKFLOW} is not registered with GitHub Actions`);
  else if (mine.state !== "active") failures.push(`${WORKFLOW} is in state "${mine.state}", not active`);

  // No second workflow should also be hitting the processor, or they fight
  // over the lease and double the cost for no benefit.
  const others = workflows.workflows.filter((w) => w.path !== `.github/workflows/${WORKFLOW}` && w.state === "active");
  console.log(`other active workflows ${others.length ? others.map((w) => w.path).join(", ") : "none"}`);
  for (const other of others) {
    const path = join(REPO, other.path);
    try {
      if (readFileSync(path, "utf8").includes("/api/internal/process")) {
        failures.push(`${other.path} also calls /api/internal/process; two schedules will contend for the processor lease`);
      }
    } catch {
      // Registered but not on disk: a deleted workflow GitHub has not yet retired.
    }
  }

  // --- 2. it is scheduled, and reads a secret that exists ---------------
  console.log();
  const yaml = readFileSync(join(REPO, `.github/workflows/${WORKFLOW}`), "utf8");
  const cron = /-\s*cron:\s*"([^"]+)"/.exec(yaml)?.[1];
  console.log(`schedule               ${cron ?? "NONE"}`);
  if (!cron) failures.push("the workflow declares no cron schedule, so nothing runs unattended");

  const secretRefs = [...yaml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  const unique = [...new Set(secretRefs)];
  console.log(`secrets referenced     ${unique.join(", ") || "none"}`);
  if (!unique.includes("CRON_SECRET")) failures.push("the workflow does not read secrets.CRON_SECRET");

  const present = JSON.parse(gh(["api", `repos/${SLUG}/actions/secrets`])) as { secrets: Array<{ name: string }> };
  const names = present.secrets.map((s) => s.name);
  console.log(`secrets on the repo    ${names.join(", ") || "none"}`);
  for (const ref of unique) {
    if (!names.includes(ref)) failures.push(`the workflow reads secrets.${ref} but no such repository secret exists`);
  }
  // A secret nothing references is the stale-rotation trap that broke the
  // previous cron, so flag it rather than leaving it to rot.
  for (const name of names) {
    if (!unique.includes(name)) {
      console.log(`  note: repository secret ${name} is referenced by no active workflow`);
      failures.push(`repository secret ${name} is referenced by no workflow; delete it or wire it up so a rotation cannot leave a consumer stale`);
    }
  }

  // --- 3. rotation keeps GitHub in sync --------------------------------
  console.log();
  const rotate = readFileSync(join(REPO, "scripts/rotate-secrets.ts"), "utf8");
  const mirrors = rotate.includes("GITHUB_MIRRORED") && /gh.*secret.*set|secret", "set/.test(rotate);
  console.log(`rotation mirrors to GitHub: ${mirrors}`);
  if (!mirrors) failures.push("scripts/rotate-secrets.ts does not mirror CRON_SECRET to GitHub, so the next rotation would break the cron again");

  // --- 4. a real run concluded successfully ----------------------------
  console.log();
  const runs = JSON.parse(gh(["api", `repos/${SLUG}/actions/workflows/${WORKFLOW}/runs?per_page=20`])) as {
    workflow_runs: Array<{ id: number; status: string; conclusion: string | null; event: string; created_at: string; head_sha: string }>;
  };
  const finished = runs.workflow_runs.filter((r) => r.status === "completed");
  console.log(`completed runs         ${finished.length}`);
  for (const r of finished.slice(0, 5)) console.log(`  ${r.created_at}  ${r.event.padEnd(18)} ${r.conclusion}  ${r.head_sha.slice(0, 8)}`);

  const successes = finished.filter((r) => r.conclusion === "success");
  if (!successes.length) failures.push("no run of this workflow has ever concluded successfully");
  else {
    const latest = successes[0];
    // The successful run must be recent enough to describe the current
    // workflow, not an ancestor that has since been edited.
    const ageHours = (Date.now() - Date.parse(latest.created_at)) / 3_600_000;
    console.log(`most recent success    ${latest.created_at} (${ageHours.toFixed(1)}h ago, sha ${latest.head_sha.slice(0, 8)})`);
    if (ageHours > 72) failures.push(`the most recent successful run is ${ageHours.toFixed(0)}h old; dispatch one to confirm the current workflow works`);

    // And the processor must have actually been reached in it.
    const log = (() => {
      try {
        return gh(["run", "view", String(latest.id), "--repo", SLUG, "--log"]);
      } catch {
        return "";
      }
    })();
    const reached = /pass \d+: HTTP (200|202)/.test(log);
    console.log(`processor answered 200/202 in that run: ${reached}`);
    if (!reached) failures.push("the successful run's log does not show the processor answering 200 or 202, so it may have passed without reaching the Court");
  }

  console.log();
  if (failures.length) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("GATE G3 PASS");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
