import { ApiError, apiError } from "@/lib/auth";
import { relayAccept, relayCreate, relayDelivery, relayLinkCase, relayRecordAccepted, relayRecordAppeal, relayRecordFinalized, relaySettlement, relayStatus, relayTerminal, type RelayProvider } from "@/lib/base-relay";
import { acquireProcessorLease, database, releaseProcessorLease } from "@/lib/db";
import { appealJudgment, configuredGenLayerContractAddress, judgmentProgress, submitAdjudication } from "@/lib/genlayer";
import { enqueueWebhook } from "@/lib/webhooks";
import { terminalRelayError } from "@/lib/processor-errors";
import { mandateTransactionFields } from "@/lib/relay-transactions";

export const runtime = "nodejs";
export const maxDuration = 60;

function authorized(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  return Boolean(process.env.CRON_SECRET && token === process.env.CRON_SECRET);
}

export async function processProtocolQueue() {
  try {
    const db = await database();
    const leaseOwner = await acquireProcessorLease(db);
    if (!leaseOwner) return Response.json({ processed: 0, skipped: true, reason: "processor lease held" }, { status: 202 });
    try {
      const jobs = await db.collection("relayJobs").find({ status: { $in: ["PENDING", "SUBMITTED", "WAITING_FOR_BASE_SUBMISSION"] }, nextAttemptAt: { $lte: new Date() } }).sort({ createdAt: 1 }).limit(10).toArray();
      const results = [];
      let baseRelaySubmitted = false;
      for (const job of jobs) {
      try {
        const mandate = await db.collection("mandates").findOne({ mandateId: job.mandateId });
        if (!mandate) throw new Error("Mandate document missing");
        if (job.status === "SUBMITTED" && job.relayTaskId) {
          const status = await relayStatus(job.relayProvider as RelayProvider, job.relayTaskId);
          if (!relayTerminal(String(status.taskState))) {
            await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { nextAttemptAt: new Date(Date.now() + 15_000), lastStatus: status, updatedAt: new Date() } });
            results.push({ job: job._id, status: status.taskState });
            continue;
          }
          if (String(status.taskState) !== "ExecSuccess") throw new Error(`${status.provider} task ${status.taskState}`);
          const nextStatus = job.type === "CREATE_MANDATE" ? "OPEN" : job.type === "ACCEPT_MANDATE" ? "ACTIVE" : job.type === "SUBMIT_DELIVERY" ? "SUBMITTED" : job.type === "SETTLEMENT" ? "SETTLED" : undefined;
          const transactionHash = status.transactionHash;
          await db.collection("mandates").updateOne(
            { _id: mandate._id },
            { $set: { ...(nextStatus ? { status: nextStatus } : {}), ...mandateTransactionFields(String(job.type), transactionHash), updatedAt: new Date() } },
          );
          await db.collection("relayJobs").updateOne(
            { _id: job._id },
            { $set: { status: "COMPLETED", lastStatus: status, ...(transactionHash ? { transactionHash } : {}), updatedAt: new Date() }, $unset: { lastError: "" } },
          );
          if (job.type === "SUBMIT_DELIVERY") await db.collection("relayJobs").updateOne({ mandateId: job.mandateId, type: "GENLAYER_ADJUDICATION" }, { $set: { status: "PENDING", nextAttemptAt: new Date() } });
          if (job.type === "CREATE_MANDATE" && mandate.providerAgentId) {
            await enqueueWebhook(mandate.providerAgentId, "mandate.assigned", { mandateId: mandate.mandateId, mandateUrl: `${process.env.NEXT_PUBLIC_APP_URL}/api/v1/mandates/${mandate.mandateId}`, acceptUrl: `${process.env.NEXT_PUBLIC_APP_URL}/api/v1/mandates/${mandate.mandateId}/accept` });
          }
          if (job.type === "SETTLEMENT") {
            await enqueueWebhook(mandate.principalAgentId, "mandate.settled", { mandateId: mandate.mandateId, manifest: mandate.manifest, judgment: mandate.judgment, transactionHash: "transactionHash" in status ? status.transactionHash : undefined });
            if (mandate.providerAgentId) {
              await enqueueWebhook(mandate.providerAgentId, "mandate.settled", { mandateId: mandate.mandateId, judgment: mandate.judgment, transactionHash: "transactionHash" in status ? status.transactionHash : undefined });
            }
          }
          if (job.type === "RECORD_FINALIZED") {
            await db.collection("relayJobs").updateOne(
              { mandateId: mandate.mandateId, type: "SETTLEMENT" },
              { $setOnInsert: { operationId: job.operationId, type: "SETTLEMENT", mandateId: mandate.mandateId, status: "PENDING", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() } },
              { upsert: true },
            );
          }
          results.push({ job: job._id, status: "COMPLETED" });
          continue;
        }
        if (["CREATE_MANDATE", "ACCEPT_MANDATE", "SUBMIT_DELIVERY", "LINK_CASE", "RECORD_ACCEPTED", "RECORD_APPEAL", "RECORD_FINALIZED", "SETTLEMENT"].includes(String(job.type)) && baseRelaySubmitted) {
          results.push({ job: job._id, status: "DEFERRED_BASE_RELAY_SERIALIZATION" });
          continue;
        }
        if (job.type === "CREATE_MANDATE") {
          const relay = await relayCreate(mandate);
          baseRelaySubmitted = true;
          await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { status: "SUBMITTED", relayProvider: relay.provider, relayTaskId: relay.taskId, relayFallbackReason: relay.fallbackReason, nextAttemptAt: new Date(Date.now() + 10_000), updatedAt: new Date() } });
        } else if (job.type === "ACCEPT_MANDATE") {
          const relay = await relayAccept(mandate);
          baseRelaySubmitted = true;
          await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { status: "SUBMITTED", relayProvider: relay.provider, relayTaskId: relay.taskId, relayFallbackReason: relay.fallbackReason, nextAttemptAt: new Date(Date.now() + 10_000), updatedAt: new Date() } });
        } else if (job.type === "SUBMIT_DELIVERY") {
          const relay = await relayDelivery(mandate);
          baseRelaySubmitted = true;
          await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { status: "SUBMITTED", relayProvider: relay.provider, relayTaskId: relay.taskId, relayFallbackReason: relay.fallbackReason, nextAttemptAt: new Date(Date.now() + 10_000), updatedAt: new Date() } });
        } else if (job.type === "SETTLEMENT") {
          const counter = await db.collection("counters").findOneAndUpdate({ name: "settlementNonce" }, { $inc: { value: 1 }, $setOnInsert: { createdAt: new Date() } }, { upsert: true, returnDocument: "after" });
          const nonce = BigInt(counter?.value ?? 1);
          const relay = await relaySettlement(mandate, nonce);
          baseRelaySubmitted = true;
          await db.collection("mandates").updateOne({ _id: mandate._id }, { $set: { settlementAttestation: { ...relay, judgment: { ...relay.judgment, nonce: relay.judgment.nonce.toString(), deadline: relay.judgment.deadline.toString() } }, status: "SETTLEMENT_PENDING", updatedAt: new Date() } });
          await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { status: "SUBMITTED", relayProvider: relay.provider, relayTaskId: relay.taskId, relayFallbackReason: relay.fallbackReason, nextAttemptAt: new Date(Date.now() + 10_000), updatedAt: new Date() } });
        } else if (job.type === "LINK_CASE") {
          const relay = await relayLinkCase(mandate);
          baseRelaySubmitted = true;
          await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { status: "SUBMITTED", relayProvider: relay.provider, relayTaskId: relay.taskId, relayFallbackReason: relay.fallbackReason, nextAttemptAt: new Date(Date.now() + 10_000), updatedAt: new Date() } });
        } else if (job.type === "RECORD_APPEAL") {
          const appeal = (mandate.appeals as Record<string, any>[] | undefined)?.find((item) => item.appealId === job.appealId);
          if (!appeal) throw new Error("Appeal record missing");
          const relay = await relayRecordAppeal(mandate, appeal);
          baseRelaySubmitted = true;
          await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { status: "SUBMITTED", relayProvider: relay.provider, relayTaskId: relay.taskId, relayFallbackReason: relay.fallbackReason, nextAttemptAt: new Date(Date.now() + 10_000), updatedAt: new Date() } });
        } else if (job.type === "RECORD_ACCEPTED") {
          const relay = await relayRecordAccepted(mandate);
          baseRelaySubmitted = true;
          await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { status: "SUBMITTED", relayProvider: relay.provider, relayTaskId: relay.taskId, relayFallbackReason: relay.fallbackReason, nextAttemptAt: new Date(Date.now() + 10_000), updatedAt: new Date() } });
        } else if (job.type === "RECORD_FINALIZED") {
          const relay = await relayRecordFinalized(mandate);
          baseRelaySubmitted = true;
          await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { status: "SUBMITTED", relayProvider: relay.provider, relayTaskId: relay.taskId, relayFallbackReason: relay.fallbackReason, nextAttemptAt: new Date(Date.now() + 10_000), updatedAt: new Date() } });
        } else if (job.type === "GENLAYER_ADJUDICATION") {
          if (!mandate.genlayerTransactionId) {
            const transactionId = await submitAdjudication(mandate);
            await db.collection("mandates").updateOne({ _id: mandate._id }, { $set: { genlayerTransactionId: transactionId, genlayerContractAddress: configuredGenLayerContractAddress(), status: "UNDER_REVIEW", updatedAt: new Date() } });
            await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { status: "SUBMITTED", genlayerTransactionId: transactionId, nextAttemptAt: new Date(Date.now() + 20_000), updatedAt: new Date() } });
            await db.collection("relayJobs").insertOne({ operationId: job.operationId, type: "LINK_CASE", mandateId: mandate.mandateId, status: "PENDING", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() });
          } else {
            const pendingAppeal = await db.collection("relayJobs").findOne({ mandateId: mandate.mandateId, type: "GENLAYER_APPEAL", status: { $in: ["PENDING", "SUBMITTED"] } });
            if (String(mandate.status) === "APPEAL_PENDING" && pendingAppeal) {
              await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { nextAttemptAt: new Date(Date.now() + 20_000), updatedAt: new Date() } });
              results.push({ job: job._id, status: "WAITING_FOR_APPEAL_SUBMISSION" });
              continue;
            }
            const finality = await judgmentProgress(mandate.genlayerTransactionId, mandate.mandateId, mandate.genlayerContractAddress);
            const stored = finality.stored as Record<string, any> | undefined;
            if (finality.accepted && stored?.judgment_hash && !mandate.acceptedJudgmentHash) {
              await db.collection("mandates").updateOne({ _id: mandate._id }, { $set: { acceptedJudgment: stored.judgment, acceptedJudgmentHash: stored.judgment_hash, status: String(mandate.status) === "APPEALED" ? "APPEALED" : "APPEAL_WINDOW", acceptedAt: new Date(), updatedAt: new Date() } });
              await db.collection("relayJobs").updateOne(
                { mandateId: mandate.mandateId, type: "RECORD_ACCEPTED" },
                { $setOnInsert: { operationId: job.operationId, type: "RECORD_ACCEPTED", mandateId: mandate.mandateId, status: "PENDING", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() } },
                { upsert: true },
              );
            }
            if (!finality.finalized) {
              await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { nextAttemptAt: new Date(Date.now() + 20_000), updatedAt: new Date() } });
            } else {
              if (!stored) throw new Error("Finalized GenLayer judgment is unavailable");
              await db.collection("mandates").updateOne({ _id: mandate._id }, { $set: { judgment: stored.judgment, judgmentHash: stored.judgment_hash, status: "FINALIZED", finalizedAt: new Date(), updatedAt: new Date() } });
              await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { status: "COMPLETED", updatedAt: new Date() }, $unset: { lastError: "" } });
              await db.collection("relayJobs").updateOne(
                { mandateId: mandate.mandateId, type: "RECORD_ACCEPTED" },
                { $setOnInsert: { operationId: job.operationId, type: "RECORD_ACCEPTED", mandateId: mandate.mandateId, status: "PENDING", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() } },
                { upsert: true },
              );
              await db.collection("relayJobs").updateOne(
                { mandateId: mandate.mandateId, type: "RECORD_FINALIZED" },
                { $setOnInsert: { operationId: job.operationId, type: "RECORD_FINALIZED", mandateId: mandate.mandateId, status: "PENDING", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() } },
                { upsert: true },
              );
            }
          }
        } else if (job.type === "GENLAYER_APPEAL") {
          const appealSubmissionHash = await appealJudgment(mandate.genlayerTransactionId);
          await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { status: "COMPLETED", appealSubmissionHash, appealedTransactionId: mandate.genlayerTransactionId, updatedAt: new Date() }, $unset: { lastError: "" } });
          await db.collection("mandates").updateOne(
            { _id: mandate._id },
            { $set: { status: "APPEALED", activeGenlayerTransactionId: mandate.genlayerTransactionId, "appeals.$[appeal].status": "SUBMITTED", "appeals.$[appeal].submissionHash": appealSubmissionHash, updatedAt: new Date() } },
            { arrayFilters: [{ "appeal.appealId": job.appealId }] },
          );
        }
        results.push({ job: job._id, status: "PROCESSED" });
      } catch (error) {
        const attempts = Number(job.attempts ?? 0) + 1;
        const terminal = terminalRelayError(error);
        await db.collection("relayJobs").updateOne({ _id: job._id }, { $set: { status: terminal || attempts >= 8 ? "FAILED" : "PENDING", attempts, lastError: error instanceof Error ? error.message : String(error), nextAttemptAt: new Date(Date.now() + Math.min(2 ** attempts * 5_000, 15 * 60_000)), updatedAt: new Date() } });
        results.push({ job: job._id, status: "ERROR", error: error instanceof Error ? error.message : String(error) });
      }
    }
    const webhookJobs = await db.collection("webhookJobs").find({ status: "PENDING", nextAttemptAt: { $lte: new Date() } }).sort({ createdAt: 1 }).limit(10).toArray();
    for (const webhook of webhookJobs) {
      try {
        const response = await fetch(String(webhook.callbackUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-mandate-court-signature": `sha256=${webhook.signature}`,
            "user-agent": "MandateCourt-Webhook/1.0",
          },
          body: String(webhook.body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
        await db.collection("webhookJobs").updateOne({ _id: webhook._id }, { $set: { status: "DELIVERED", deliveredAt: new Date(), updatedAt: new Date() } });
        results.push({ webhook: webhook._id, status: "DELIVERED" });
      } catch (error) {
        const attempts = Number(webhook.attempts ?? 0) + 1;
        await db.collection("webhookJobs").updateOne({ _id: webhook._id }, { $set: { status: attempts >= 8 ? "FAILED" : "PENDING", attempts, lastError: error instanceof Error ? error.message : String(error), nextAttemptAt: new Date(Date.now() + Math.min(2 ** attempts * 5_000, 15 * 60_000)), updatedAt: new Date() } });
        results.push({ webhook: webhook._id, status: "ERROR" });
      }
    }
      return Response.json({ processed: results.length, results });
    } finally {
      await releaseProcessorLease(db, leaseOwner);
    }
  } catch (error) {
    return apiError(error);
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) return apiError(new ApiError(401, "Invalid cron authorization"));
  return processProtocolQueue();
}
