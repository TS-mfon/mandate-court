// Step 6: submit the delivery manifest as provider.
//
// Every artifact and evidence item maps to acceptance-criterion IDs from the
// mandate. An item mapped to nothing earns nothing, and a criterion nothing
// maps to fails, so the mapping below covers C1, C2, and C3 exactly once.
// URLs are pinned to a full commit SHA and the hashes are of the bytes that
// URL actually served, read back in step 5.
import { api, currentRunId, loadState, log, must, saveState, walletFor } from "./lib";
import { waitForOperation } from "./pump";

async function main() {
  const runId = currentRunId();
  const state = loadState(runId);
  const provider = state.provider as { privateKey: string; address: string };
  const apiKey = state.providerApiKey as string;
  const { account } = walletFor(provider.privateKey);
  const mandateId = state.mandateId as string;
  const sha = state.deliveryCommitSha as string;
  const published = state.publishedArtifacts as Record<string, { url: string; sha256: string; bytes: number }>;

  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`delivery commit SHA is not a 40-character hex string: ${sha}`);
  for (const [file, meta] of Object.entries(published)) {
    if (!meta.url.includes(sha)) throw new Error(`${file} URL is not pinned to the commit SHA`);
  }

  const manifest = {
    protocol: "mdp/1.1",
    mandateId,
    providerAgentId: state.providerAgentId as string,
    submittedAt: new Date().toISOString(),
    summary: `${state.recordCount} earthquake records collected from the USGS FDSN event service on ${String(state.collectedAt).slice(0, 10)}, each populating all six required fields, with a resolvable earthquake.usgs.gov event URL for every record. Published at commit ${sha}.`,
    artifacts: [
      {
        id: "results",
        type: "json",
        url: published["results.json"].url,
        sha256: published["results.json"].sha256,
        mediaType: "application/json",
        criteria: ["C1"],
        contentLength: published["results.json"].bytes,
        immutableRevision: sha,
      },
      {
        id: "readme",
        type: "document",
        url: published["README.md"].url,
        sha256: published["README.md"].sha256,
        mediaType: "text/markdown",
        criteria: ["C3"],
        contentLength: published["README.md"].bytes,
        immutableRevision: sha,
      },
    ],
    evidence: [
      {
        id: "source-registry",
        type: "source",
        url: published["sources.json"].url,
        sha256: published["sources.json"].sha256,
        supports: ["C2"],
        sourceType: "PRIMARY",
        claim: `sources.json maps all ${state.recordCount} event_ids in results.json to their USGS event page URLs on earthquake.usgs.gov, the authoritative catalog the records were collected from.`,
      },
    ],
  };

  const idempotencyKey = crypto.randomUUID();
  log("requesting delivery preparation");
  const prep = await api(`/api/v1/mandates/${mandateId}/deliver`, {
    method: "POST",
    apiKey,
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({ manifest }),
  });
  log(`delivery preparation -> ${prep.status}`);
  const prepared = prep.body as { deliveryHash?: string; actorTypedData?: Record<string, unknown>; snapshots?: unknown[] };
  if (prep.status >= 400 && prep.status !== 428) throw new Error(`delivery preparation failed: ${prep.status} ${JSON.stringify(prep.body).slice(0, 800)}`);
  if (!prepared?.actorTypedData || !prepared.deliveryHash) throw new Error(`delivery preparation incomplete: ${JSON.stringify(prep.body).slice(0, 800)}`);

  // The Court re-downloaded and re-hashed every URL during preparation.
  const snapshots = (prepared.snapshots ?? []) as Array<Record<string, unknown>>;
  log(`court captured ${snapshots.length} snapshot(s)`);
  for (const snapshot of snapshots) {
    log(`  ${snapshot.id ?? snapshot.url} status=${snapshot.status ?? "-"} match=${snapshot.hashMatches ?? snapshot.match ?? "-"}`);
  }

  const signature = await account.signTypedData(prepared.actorTypedData as never);
  const message = (prepared.actorTypedData as { message: Record<string, unknown> }).message;
  const actorAuthorization = { ...message, nonce: String(message.nonce), deadline: String(message.deadline), signature };

  const submitted = must(
    await api(`/api/v1/mandates/${mandateId}/deliver`, {
      method: "POST",
      apiKey,
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ manifest, actorAuthorization, deliveryHash: prepared.deliveryHash }),
    }),
    "submitDelivery",
  ) as { operationId: string };

  log(`delivery submitted -> ${submitted.operationId}`);
  saveState(runId, { deliveryManifest: manifest, deliveryHash: prepared.deliveryHash, deliverySnapshots: snapshots, deliveryOperationId: submitted.operationId });

  const op = await waitForOperation(submitted.operationId, 900, apiKey);
  log(`delivery operation ${op.status}`);
  const jobs = (op as { jobs?: Array<Record<string, unknown>> }).jobs ?? [];
  for (const job of jobs) log(`  relay ${job.type} ${job.status} tx=${job.transactionHash ?? "-"}`);
  if (op.status !== "COMPLETED") throw new Error(`delivery did not complete: ${JSON.stringify(op).slice(0, 600)}`);
  saveState(runId, { deliveryTxHash: jobs[0]?.transactionHash ?? null });

  const after = must(await api(`/api/v1/mandates/${mandateId}`, { apiKey }), "inspect after delivery") as Record<string, unknown>;
  log(`mandate status now ${((after.mandate ?? after) as Record<string, unknown>).status}`);
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
