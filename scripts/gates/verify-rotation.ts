// G2 oracle. Proves the rotation actually reached the running deployment
// rather than only being accepted by the Vercel API.
//
// Three independent assertions, each with a control:
//
//   API_KEY_PEPPER    A key minted before rotation must now be rejected, and a
//                     key minted after rotation must authenticate. The
//                     pre-rotation key was proven working against the previous
//                     deployment first, so its rejection here is evidence of
//                     rotation and not of a key that never worked.
//   WEBHOOK_ENCRYPTION_KEY  /api/v1/health reports webhookEncryption "ok" only
//                     when the variable is present; the fallback path reports
//                     "fallback_api_key_pepper".
//   CRON_SECRET       The previous value must be rejected by the cron endpoint
//                     and the current value accepted, which also confirms the
//                     endpoint is not simply open.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { api, BASE_URL, currentRunId, envFile, loadState, newWallet, walletFor } from "../live/lib";

const REPO = "/home/sudodave/mandate-court";

async function mintKey(privateKey: string, name: string) {
  const { account } = walletFor(privateKey);
  const challenge = await api("/api/v1/auth/challenge", { method: "POST", body: JSON.stringify({ walletAddress: account.address }) });
  if (challenge.status >= 400) return { status: challenge.status, apiKey: null as string | null };
  const { challengeId, message } = challenge.body as { challengeId: string; message: string };
  const signature = await account.signMessage({ message });
  const created = await api("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ challengeId, signature, name }) });
  return { status: created.status, apiKey: (created.body as { apiKey?: string })?.apiKey ?? null };
}

async function main() {
  const failures: string[] = [];
  const runId = currentRunId();
  const state = loadState(runId);
  const current = envFile();

  console.log(`target: ${BASE_URL}`);
  console.log(`run:    ${runId}`);
  console.log();

  // --- API_KEY_PEPPER ------------------------------------------------------
  const controlKey = state.controlApiKey as string | undefined;
  if (!controlKey) throw new Error("run state has no controlApiKey; the pre-rotation control was never captured");
  if (!state.controlProvenWorkingAt) throw new Error("run state does not record the control key working before rotation");

  const oldKey = await api("/api/v1/api-keys", { apiKey: controlKey });
  console.log(`pre-rotation key (proven working ${String(state.controlProvenWorkingAt).slice(11, 19)}) -> ${oldKey.status}`);
  if (oldKey.status !== 401) failures.push(`pre-rotation API key returned ${oldKey.status}, expected 401 after API_KEY_PEPPER rotation`);

  const fresh = newWallet();
  const minted = await mintKey(fresh.privateKey, "G2 post-rotation probe");
  console.log(`post-rotation mint -> ${minted.status}${minted.apiKey ? " (key issued)" : ""}`);
  if (minted.status >= 400 || !minted.apiKey) failures.push(`could not mint an API key after rotation (status ${minted.status})`);
  else {
    const authed = await api("/api/v1/api-keys", { apiKey: minted.apiKey });
    console.log(`post-rotation key authenticates -> ${authed.status}`);
    if (authed.status !== 200) failures.push(`freshly minted key returned ${authed.status}, expected 200`);
  }

  // --- WEBHOOK_ENCRYPTION_KEY ---------------------------------------------
  console.log();
  const health = await api("/api/v1/health");
  const checks = (health.body as { checks?: Record<string, string>; version?: string })?.checks ?? {};
  console.log(`health webhookEncryption -> ${checks.webhookEncryption ?? "(absent)"}`);
  if (checks.webhookEncryption !== "ok") failures.push(`health reports webhookEncryption "${checks.webhookEncryption}", expected "ok" (WEBHOOK_ENCRYPTION_KEY not live)`);

  // --- CRON_SECRET ---------------------------------------------------------
  console.log();
  const backups = readdirSync(REPO).filter((f) => f.startsWith(".env.build.bak-")).sort();
  if (!backups.length) throw new Error("no .env.build backup found; cannot prove the previous CRON_SECRET is now rejected");
  const previous = Object.fromEntries(
    readFileSync(join(REPO, backups.at(-1)!), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trimStart().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)] as const; }),
  ) as Record<string, string>;

  if (previous.CRON_SECRET === current.CRON_SECRET) failures.push("CRON_SECRET is unchanged between the backup and the current .env.build");
  else console.log("CRON_SECRET differs from the pre-rotation value");

  // The cron route exports GET only, which is what Vercel Cron issues.
  const cronOld = await api("/api/internal/process", { headers: { authorization: `Bearer ${previous.CRON_SECRET}` } });
  const cronNew = await api("/api/internal/process", { headers: { authorization: `Bearer ${current.CRON_SECRET}` } });
  const cronNone = await api("/api/internal/process");
  console.log(`cron with previous secret -> ${cronOld.status}`);
  console.log(`cron with current secret  -> ${cronNew.status}`);
  console.log(`cron with no secret       -> ${cronNone.status}`);
  if (cronNone.status !== 401) failures.push(`cron endpoint is open: unauthenticated GET returned ${cronNone.status}, expected 401`);
  if (cronOld.status !== 401) failures.push(`cron endpoint accepted the previous CRON_SECRET (status ${cronOld.status}), expected 401`);
  if (cronNew.status === 401) failures.push("cron endpoint rejected the current CRON_SECRET");

  // API_KEY_PEPPER and WEBHOOK_SIGNING_SECRET must also differ from backup.
  console.log();
  for (const key of ["API_KEY_PEPPER", "WEBHOOK_SIGNING_SECRET"]) {
    const changed = previous[key] !== current[key];
    console.log(`${key} differs from pre-rotation value: ${changed}`);
    if (!changed) failures.push(`${key} is unchanged between the backup and the current .env.build`);
  }

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
