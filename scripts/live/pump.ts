// Drives the serverless queue and waits for an operation to become terminal.
// Vercel Cron only fires daily on this project, so the run pokes the processor
// itself. The endpoint is lease-guarded, so repeated calls are safe.
//
//   npx tsx scripts/live/pump.ts <operationId> [timeoutSeconds]
import { api, envFile, log, sleep } from "./lib";

export async function pumpOnce() {
  const env = envFile();
  const res = await api("/api/internal/process", { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
  if (res.status !== 200) log(`processor -> ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return res;
}

export async function waitForOperation(operationId: string, timeoutSeconds = 600, apiKey?: string) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = "";
  while (Date.now() < deadline) {
    await pumpOnce();
    const res = await api(`/api/v1/operations/${operationId}`, apiKey ? { apiKey } : {});
    if (res.status === 401 || res.status === 403) throw new Error(`operation lookup needs credentials: ${res.status}. Pass an apiKey.`);
    // The route answers { operation, jobs }; older shapes returned the
    // operation at the top level, so accept both.
    const envelope = res.body as { operation?: { status?: string }; jobs?: unknown[]; status?: string };
    const op = envelope?.operation ?? envelope;
    const status = op?.status ?? `http ${res.status}`;
    if (status !== last) {
      log(`operation ${operationId} -> ${status}`);
      last = status;
    }
    if (status === "COMPLETED" || status === "FAILED") return { ...op, jobs: envelope?.jobs ?? [] };
    await sleep(5_000);
  }
  throw new Error(`operation ${operationId} did not become terminal within ${timeoutSeconds}s`);
}

async function main() {
  const [operationId, timeout] = process.argv.slice(2);
  if (!operationId) {
    const res = await pumpOnce();
    console.log(JSON.stringify(res.body, null, 2).slice(0, 2000));
    return;
  }
  const { currentRunId, loadState } = await import("./lib");
  const state = loadState(currentRunId());
  const apiKey = (state.principalApiKey ?? state.providerApiKey) as string | undefined;
  const op = await waitForOperation(operationId, timeout ? Number(timeout) : 600, apiKey);
  console.log(JSON.stringify(op, null, 2).slice(0, 3000));
}

if (process.argv[1]?.endsWith("pump.ts")) {
  main().catch((error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  });
}
