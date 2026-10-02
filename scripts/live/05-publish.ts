// Step 5: publish the deliverable to a public GitHub repository and pin it.
//
// The order of operations is the one the evidence skill insists on and it is
// not optional: publish first, then download the bytes the published URL
// actually serves, and hash those. Hashing the local file would pass here and
// fail at adjudication, because the Court re-downloads and re-hashes.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { currentRunId, loadState, log, saveState, sha256Hex, sleep } from "./lib";

const OWNER = "TS-mfon";
const REPO = process.env.DELIVERY_REPO ?? `mandate-court-usgs-delivery-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gh(args: string[]) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function main() {
  const runId = currentRunId();
  const state = loadState(runId);
  const dir = state.deliverableDir as string;
  if (!existsSync(dir)) throw new Error(`deliverable directory ${dir} does not exist; run 04-do-work.ts first`);
  const files = readdirSync(dir).sort();
  log(`publishing ${files.join(", ")} to ${OWNER}/${REPO}`);

  // --- create the repository if it does not exist --------------------------
  let repoExists = true;
  try {
    gh(["repo", "view", `${OWNER}/${REPO}`, "--json", "name"]);
  } catch {
    repoExists = false;
  }
  if (!repoExists) {
    gh(["repo", "create", `${OWNER}/${REPO}`, "--public", "--description", "Mandate Court delivery: USGS earthquake dataset with per-record primary source citations."]);
    log(`created ${OWNER}/${REPO}`);
  } else {
    log(`${OWNER}/${REPO} already exists, pushing to it`);
  }

  // --- commit and push -----------------------------------------------------
  if (!existsSync(join(dir, ".git"))) {
    git(["init", "-q", "-b", "main"], dir);
    git(["remote", "add", "origin", `https://github.com/${OWNER}/${REPO}.git`], dir);
  }
  git(["add", "-A"], dir);
  try {
    git(["commit", "-q", "-m", `USGS earthquake dataset for mandate ${state.mandateId}\n\n${state.recordCount} records collected ${state.collectedAt} from the USGS FDSN event service,\neach with a resolvable earthquake.usgs.gov source URL.`], dir);
  } catch (error) {
    const text = String(error);
    if (!text.includes("nothing to commit")) throw error;
    log("nothing new to commit");
  }
  git(["push", "-q", "-u", "origin", "main", "--force"], dir);
  const sha = git(["rev-parse", "HEAD"], dir);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`expected a 40-character commit SHA, got ${sha}`);
  log(`pushed, commit ${sha}`);

  // --- download the published bytes and hash those ------------------------
  const artifacts: Record<string, { url: string; sha256: string; bytes: number }> = {};
  for (const file of files) {
    if (file === ".git") continue;
    const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${sha}/${file}`;
    let body: ArrayBuffer | null = null;
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        body = await response.arrayBuffer();
        break;
      }
      log(`  ${file} -> HTTP ${response.status}, retrying (${attempt}/12)`);
      await sleep(5_000);
    }
    if (!body) throw new Error(`${url} never became available`);
    const bytes = Buffer.from(body);
    artifacts[file] = { url, sha256: sha256Hex(bytes), bytes: bytes.length };
    log(`  ${file.padEnd(14)} ${String(bytes.length).padStart(6)} bytes  ${artifacts[file].sha256}`);
  }

  saveState(runId, { deliveryRepo: `${OWNER}/${REPO}`, deliveryRepoUrl: `https://github.com/${OWNER}/${REPO}`, deliveryCommitSha: sha, publishedArtifacts: artifacts });
  log("published and hashed from the served bytes");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
