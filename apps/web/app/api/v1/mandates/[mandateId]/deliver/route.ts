import { deliveryManifestSchema } from "@mandate-court/schemas";
import { apiError, authenticate, requireScope, ApiError } from "@/lib/auth";
import { actionHash, actorTypedData, currentActorNonce, deliveryPayloadHash, type ActorAuthorization, verifyActorAuthorization } from "@/lib/action-auth";
import { canonicalHash } from "@/lib/crypto";
import { database } from "@/lib/db";
import { snapshotManifest } from "@/lib/evidence";
import { beginOperation } from "@/lib/operations";
import { deliveryTimestampIsCurrent } from "@/lib/delivery-time";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ mandateId: string }> }) {
  try {
    const agent = await authenticate(request);
    requireScope(agent, "protocol:read");
    const { mandateId } = await context.params;
    const db = await database();
    const mandate = await db.collection("mandates").findOne({ mandateId });
    if (!mandate) throw new ApiError(404, "Mandate not found");
    if (mandate.principalAgentId !== agent.agentId && mandate.providerAgentId !== agent.agentId) {
      throw new ApiError(403, "Only case parties may retrieve the delivery");
    }
    if (!["FINALIZED", "SETTLEMENT_PENDING", "SETTLED"].includes(String(mandate.status))) {
      throw new ApiError(409, "Delivery is released after the final judgment");
    }
    return Response.json({ mandateId, manifest: mandate.manifest, snapshots: mandate.snapshots, deliveryHash: mandate.deliveryHash, judgment: mandate.judgment });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ mandateId: string }> }) {
  try {
    const agent = await authenticate(request);
    requireScope(agent, "protocol:write");
    const { mandateId } = await context.params;
    const body = await request.json();
    const manifest = deliveryManifestSchema.parse(body.manifest);
    if (manifest.mandateId !== mandateId || manifest.providerAgentId !== agent.agentId) throw new ApiError(403, "Delivery identity mismatch");
    const db = await database();
    const mandate = await db.collection("mandates").findOne({ mandateId });
    if (!mandate) throw new ApiError(404, "Mandate not found");
    if (mandate.providerAgentId !== agent.agentId) throw new ApiError(403, "Only the accepted provider may deliver");
    if (mandate.status !== "ACTIVE") throw new ApiError(409, "Mandate is not active for delivery");
    if (Date.now() > Date.parse(String(mandate.mandate.deliveryDeadline))) throw new ApiError(409, "Delivery deadline passed");
    if (!deliveryTimestampIsCurrent(manifest.submittedAt, String(mandate.mandate.deliveryDeadline))) {
      throw new ApiError(422, "Delivery submittedAt must be within 15 minutes of server time and no later than the delivery deadline");
    }
    const manifestHash = canonicalHash(manifest);
    const prepared = mandate.deliveryPreparation as { manifestHash?: string; deliveryHash?: `0x${string}`; snapshots?: unknown[] } | undefined;
    let snapshots: unknown[];
    let deliveryHash: `0x${string}`;
    if (!body.actorAuthorization) {
      if (prepared?.deliveryHash && prepared.manifestHash === manifestHash) {
        snapshots = prepared.snapshots ?? [];
        deliveryHash = prepared.deliveryHash;
      } else {
        snapshots = await snapshotManifest(manifest);
        deliveryHash = canonicalHash({ manifest, snapshots }) as `0x${string}`;
        await db.collection("mandates").updateOne({ _id: mandate._id }, { $set: { deliveryPreparation: { manifestHash, deliveryHash, snapshots, preparedAt: new Date() }, updatedAt: new Date() } });
      }
      const payloadHash = deliveryPayloadHash(mandate.onchainMandateId, deliveryHash);
      const actorNonce = await currentActorNonce(agent.walletAddress);
      const unsigned = { mandateId: mandate.onchainMandateId, action: actionHash("submit"), payloadHash, actor: agent.walletAddress, nonce: String(actorNonce), deadline: String(body.authorizationDeadline ?? Math.floor(Date.now() / 1000) + 3600) };
      return Response.json({ deliveryHash, snapshots, actorTypedData: actorTypedData(unsigned), preparationRequired: true }, { status: 428 });
    }
    if (!prepared?.deliveryHash || prepared.manifestHash !== manifestHash || body.deliveryHash !== prepared.deliveryHash) {
      throw new ApiError(428, "Prepare delivery first and submit the returned deliveryHash");
    }
    snapshots = prepared.snapshots ?? [];
    deliveryHash = prepared.deliveryHash;
    const payloadHash = deliveryPayloadHash(mandate.onchainMandateId, deliveryHash);
    const actorNonce = await currentActorNonce(agent.walletAddress);
    const unsigned = { mandateId: mandate.onchainMandateId, action: actionHash("submit"), payloadHash, actor: agent.walletAddress, nonce: String(actorNonce), deadline: String(body.authorizationDeadline ?? Math.floor(Date.now() / 1000) + 3600) };
    const valid = await verifyActorAuthorization(agent, body.actorAuthorization as ActorAuthorization, { mandateId: mandate.onchainMandateId, action: actionHash("submit"), payloadHash, nonce: actorNonce });
    if (!valid) throw new ApiError(403, "Invalid actor authorization");
    const started = await beginOperation(request, agent.agentId, "SUBMIT_DELIVERY", canonicalHash(body));
    if (started.existing) return Response.json(started.operation);
    await db.collection("mandates").updateOne({ mandateId }, { $set: { manifest, snapshots, deliveryHash, deliveryAuthorization: body.actorAuthorization, status: "DELIVERY_RELAY_PENDING", operationId: started.operation.operationId, updatedAt: new Date() }, $unset: { deliveryPreparation: "" } });
    await db.collection("relayJobs").insertMany([
      { operationId: started.operation.operationId, type: "SUBMIT_DELIVERY", mandateId, status: "PENDING", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() },
      { operationId: started.operation.operationId, type: "GENLAYER_ADJUDICATION", mandateId, status: "WAITING_FOR_BASE_SUBMISSION", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() },
    ]);
    return Response.json({ mandateId, deliveryHash, snapshots, operationId: started.operation.operationId, status: "DELIVERY_RELAY_PENDING" }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
