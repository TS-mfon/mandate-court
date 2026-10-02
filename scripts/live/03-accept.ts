// Step 3: the provider discovers the mandate on the open docket and accepts it.
//
// Discovery is done through the docket rather than by using the mandateId we
// already know, because that is the path a real provider agent takes and it
// exercises the hard-requirement filtering and match explanations added in this
// milestone.
import { api, currentRunId, loadState, log, must, saveState, walletFor } from "./lib";
import { waitForOperation } from "./pump";

async function main() {
  const runId = currentRunId();
  const state = loadState(runId);
  const provider = state.provider as { privateKey: string; address: string };
  const apiKey = state.providerApiKey as string;
  const { account } = walletFor(provider.privateKey);
  const expectedMandateId = state.mandateId as string;

  // --- discover on the docket ---------------------------------------------
  const docket = must(
    await api("/api/v1/docket?skill=research&policy=RESEARCH_DATA_V2&limit=20", { apiKey }),
    "listDocket",
  ) as { mandates?: Array<Record<string, unknown>>; entries?: Array<Record<string, unknown>> };
  const entries = docket.mandates ?? docket.entries ?? [];
  log(`docket returned ${entries.length} matching mandate(s)`);
  for (const entry of entries) {
    log(`  ${entry.mandateId} policy=${entry.policy ?? "-"} match=${JSON.stringify(entry.match ?? null)}`);
  }
  const found = entries.find((e) => e.mandateId === expectedMandateId);
  if (!found) throw new Error(`mandate ${expectedMandateId} was not discoverable on the docket`);
  log(`discovered ${expectedMandateId} via the open docket`);
  saveState(runId, { docketEntry: found, docketMatch: found.match ?? null });

  // --- read it in full before accepting -----------------------------------
  const full = must(await api(`/api/v1/mandates/${expectedMandateId}`, { apiKey }), "inspectMandate") as Record<string, unknown>;
  const mandate = (full.mandate ?? full) as Record<string, unknown>;
  const doc = (mandate.mandate ?? mandate) as Record<string, unknown>;
  log(`payment ${JSON.stringify((doc.payment as Record<string, unknown>)?.amountAtomic)} atomic, deadline ${doc.deliveryDeadline}`);

  // --- accept --------------------------------------------------------------
  const idempotencyKey = crypto.randomUUID();
  const prep = await api(`/api/v1/mandates/${expectedMandateId}/accept`, {
    method: "POST",
    apiKey,
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({}),
  });
  log(`accept preparation -> ${prep.status}`);
  const prepared = prep.body as { actorTypedData?: Record<string, unknown> };
  if (prep.status >= 400 && prep.status !== 428) throw new Error(`accept preparation failed: ${prep.status} ${JSON.stringify(prep.body).slice(0, 400)}`);
  if (!prepared?.actorTypedData) throw new Error("accept preparation returned no actorTypedData");

  const signature = await account.signTypedData(prepared.actorTypedData as never);
  const message = (prepared.actorTypedData as { message: Record<string, unknown> }).message;
  const actorAuthorization = { ...message, nonce: String(message.nonce), deadline: String(message.deadline), signature };

  const accepted = must(
    await api(`/api/v1/mandates/${expectedMandateId}/accept`, {
      method: "POST",
      apiKey,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ actorAuthorization }),
    }),
    "acceptMandate",
  ) as { operationId: string };

  log(`accept submitted -> ${accepted.operationId}`);
  saveState(runId, { acceptOperationId: accepted.operationId, acceptIdempotencyKey: idempotencyKey });

  const op = await waitForOperation(accepted.operationId, 600, apiKey);
  log(`accept operation ${op.status}`);
  const jobs = (op as { jobs?: Array<Record<string, unknown>> }).jobs ?? [];
  for (const job of jobs) log(`  relay ${job.type} ${job.status} tx=${job.transactionHash ?? "-"}`);
  if (op.status !== "COMPLETED") throw new Error(`accept did not complete: ${JSON.stringify(op).slice(0, 500)}`);
  saveState(runId, { acceptTxHash: jobs[0]?.transactionHash ?? null });

  const after = must(await api(`/api/v1/mandates/${expectedMandateId}`, { apiKey }), "inspect after accept") as Record<string, unknown>;
  const status = ((after.mandate ?? after) as Record<string, unknown>).status;
  log(`mandate status now ${status}`);
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
