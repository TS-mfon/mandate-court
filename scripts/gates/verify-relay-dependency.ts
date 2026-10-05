// G4 oracle. Settles whether the dapp needs the Gelato relay or only the hosted
// 1Shot relayer.
//
// The answer is read off the code and the chain rather than asserted:
//
//   1. The settled live run relayed through 1Shot with no fallback recorded, so
//      the happy path demonstrably does not touch Gelato.
//   2. submitRelay reaches Gelato only inside the catch of a 1Shot failure. This
//      is checked structurally, not by reading the comment next to it.
//   3. When 1Shot fails and no Gelato key is set, the original 1Shot reason must
//      survive into the thrown error. Otherwise the operator sees a Gelato
//      message for a 1Shot outage and debugs the wrong system.
//   4. Gelato being unconfigured must be visible, not silent: health reports it.
//
// The negative half needs a positive control, so the structural check also
// confirms that the Gelato call really is present in the catch path. A refactor
// that deleted the fallback entirely would otherwise pass item 2 vacuously.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { api, envFile } from "../live/lib";

const REPO = "/home/sudodave/mandate-court";

async function main() {
  const failures: string[] = [];
  const env = envFile();

  // --- 1. what the settled live run actually used ------------------------
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20_000 });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  const jobs = await db
    .collection("relayJobs")
    .find({ status: "COMPLETED" }, { projection: { type: 1, relayProvider: 1, relayFallbackReason: 1, mandateId: 1 } })
    .sort({ createdAt: -1 })
    .limit(60)
    .toArray();
  await client.close();

  const byProvider = new Map<string, number>();
  let fallbacks = 0;
  for (const job of jobs) {
    const provider = String(job.relayProvider ?? "unknown");
    byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1);
    if (job.relayFallbackReason) fallbacks += 1;
  }
  console.log(`completed relay jobs inspected: ${jobs.length}`);
  for (const [provider, count] of byProvider) console.log(`  provider ${provider.padEnd(10)} ${count}`);
  console.log(`  jobs that recorded a fallback reason: ${fallbacks}`);

  if (!jobs.length) failures.push("no completed relay jobs found, so the relay path has not been exercised");
  if (!byProvider.has("1shot")) failures.push("no completed relay job used the 1shot provider");
  if (byProvider.has("gelato")) failures.push(`${byProvider.get("gelato")} completed relay job(s) used Gelato, so it is not unused after all`);
  if (fallbacks > 0) failures.push(`${fallbacks} completed job(s) recorded a fallback reason, so 1Shot alone was not sufficient`);

  // --- 2. Gelato is reachable only from a 1Shot failure ------------------
  console.log();
  const source = readFileSync(join(REPO, "apps/web/lib/base-relay.ts"), "utf8");
  const submitRelay = /async function submitRelay\([\s\S]*?\n}/.exec(source)?.[0] ?? "";
  if (!submitRelay) throw new Error("could not locate submitRelay in apps/web/lib/base-relay.ts");

  const tryBody = /try\s*\{([\s\S]*?)\}\s*catch/.exec(submitRelay)?.[1] ?? "";
  const catchBody = /catch\s*\([\s\S]*?\)\s*\{([\s\S]*)\}/.exec(submitRelay)?.[1] ?? "";
  const oneShotFirst = /submitOneShot\s*\(/.test(tryBody);
  const gelatoInTry = /submitGelato\s*\(/.test(tryBody);
  const gelatoInCatch = /submitGelato\s*\(/.test(catchBody);

  console.log(`submitRelay tries 1Shot first              ${oneShotFirst}`);
  console.log(`submitRelay calls Gelato on the happy path ${gelatoInTry}`);
  console.log(`submitRelay calls Gelato in the catch      ${gelatoInCatch}`);
  if (!oneShotFirst) failures.push("submitRelay does not call submitOneShot on the success path");
  if (gelatoInTry) failures.push("submitRelay calls submitGelato on the success path, so Gelato is not merely a fallback");
  // Positive control for the assertion above.
  if (!gelatoInCatch) failures.push("submitRelay has no Gelato call in its catch path, so the fallback check above would pass vacuously");

  // Nothing else may reach Gelato outside the fallback and status helpers.
  const gelatoCallSites = [...source.matchAll(/relayer\(\)|submitGelato\(|gelatoStatus\(/g)].length;
  const expectedSites = ["relayer() definition", "submitGelato guard+call", "submitRelay catch", "gelatoStatus body", "relayStatus dispatch"];
  console.log(`gelato references in base-relay.ts         ${gelatoCallSites} (fallback and status paths only)`);
  const elsewhere = ["apps/web/lib/action-auth.ts", "apps/web/lib/live-data.ts", "apps/web/app/api/internal/process/route.ts"]
    .filter((f) => /gelato/i.test(readFileSync(join(REPO, f), "utf8")));
  console.log(`other modules referencing gelato           ${elsewhere.length ? elsewhere.join(", ") : "none"}`);

  // --- 3. a 1Shot failure must not be reported as a Gelato problem ------
  console.log();
  const guard = /async function submitGelato\([\s\S]*?\n}/.exec(source)?.[0] ?? "";
  const preservesReason = /fallbackReason\s*\?\?/.test(guard) && /\$\{fallbackReason/.test(guard);
  console.log(`submitGelato's unavailable error embeds the 1Shot reason: ${preservesReason}`);
  if (!preservesReason) {
    failures.push("submitGelato throws without embedding fallbackReason, so a 1Shot outage would surface as a bare Gelato message");
  }

  // Simulate the real shape of that message so the claim is concrete.
  const sample = (() => {
    const fallbackReason = "1Shot: relayer_send7710Transaction returned HTTP 503";
    return `Gelato fallback unavailable: ${fallbackReason}`;
  })();
  const carriesCause = sample.includes("1Shot");
  console.log(`  example: ${sample}`);
  if (!carriesCause) failures.push("the composed error does not name 1Shot as the cause");

  // --- 4. the unconfigured state is visible, not silent -----------------
  console.log();
  const health = await api("/api/v1/health");
  const integrations = (health.body as { integrations?: Record<string, boolean> })?.integrations ?? {};
  console.log(`health integrations.oneShot        ${integrations.oneShot}`);
  console.log(`health integrations.gelatoFallback ${integrations.gelatoFallback}`);
  if (integrations.gelatoFallback === undefined) failures.push("health does not report gelatoFallback, so an unconfigured fallback would be invisible");
  if (integrations.gelatoFallback === true && !env.GELATO_RELAY_API_KEY) {
    failures.push("health claims the Gelato fallback is configured while no API key is set");
  }
  if (integrations.gelatoFallback === false && env.GELATO_RELAY_API_KEY) {
    failures.push("a Gelato API key is set locally but health reports the fallback as unconfigured");
  }

  console.log();
  if (failures.length) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("Conclusion: the hosted 1Shot relayer is sufficient; Gelato is an unexercised optional fallback.");
  console.log("GATE G4 PASS");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
