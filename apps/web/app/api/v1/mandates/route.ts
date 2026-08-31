import { mandateSchema } from "@mandate-court/schemas";
import { zeroAddress, keccak256, stringToHex } from "viem";
import { apiError, authenticate, requireScope, ApiError } from "@/lib/auth";
import { actionHash, actorTypedData, createPayloadHash, currentActorNonce, mandateIdHash, type ActorAuthorization, verifyActorAuthorization } from "@/lib/action-auth";
import { canonicalHash, identifier } from "@/lib/crypto";
import { database } from "@/lib/db";
import { beginOperation } from "@/lib/operations";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const assignedTo = url.searchParams.get("assignedTo");
    const policy = url.searchParams.get("policy");
    const query: Record<string, unknown> = {};
    if (status) query.status = status;
    if (policy) query.policy = policy;
    if (assignedTo) query.providerAgentId = assignedTo;
    const db = await database();
    const mandates = await db.collection("mandates").find(query, { projection: { _id: 0, actorAuthorization: 0, manifest: 0, snapshots: 0, deliveryPreparation: 0, settlementAttestation: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
    return Response.json({ mandates });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const agent = await authenticate(request);
    requireScope(agent, "protocol:write");
    const body = await request.json();
    const mandate = mandateSchema.parse(body.mandate);
    const db = await database();
    const mandateId = String(body.mandateId ?? identifier("MC"));
    const onchainMandateId = mandateIdHash(mandateId);
    const adjudicationMandate = { mandateId, ...mandate };
    const mandateHash = canonicalHash(adjudicationMandate) as `0x${string}`;
    const policyHash = keccak256(stringToHex(mandate.policy));
    if (Boolean(mandate.providerAgentId) !== Boolean(mandate.providerWallet)) {
      throw new ApiError(422, "providerAgentId and providerWallet must be supplied together");
    }
    if (mandate.providerAgentId) {
      const assigned = await db.collection("agents").findOne({ agentId: mandate.providerAgentId });
      if (!assigned || String(assigned.walletAddress).toLowerCase() !== String(mandate.providerWallet).toLowerCase()) {
        throw new ApiError(422, "Assigned provider identity does not match its registered wallet");
      }
    }
    const provider = (mandate.providerWallet ?? zeroAddress) as `0x${string}`;
    const payloadHash = createPayloadHash({
      provider,
      mandateHash,
      policyHash,
      amount: BigInt(mandate.payment.amountAtomic),
      acceptanceDeadline: BigInt(Math.floor(Date.parse(mandate.acceptanceDeadline) / 1000)),
      deliveryDeadline: BigInt(Math.floor(Date.parse(mandate.deliveryDeadline) / 1000)),
    });
    const actorNonce = await currentActorNonce(agent.walletAddress);
    const unsigned = {
      mandateId: onchainMandateId,
      action: actionHash("create"),
      payloadHash,
      actor: agent.walletAddress,
      nonce: String(actorNonce),
      deadline: String(body.authorizationDeadline ?? Math.floor(Date.now() / 1000) + 3600),
    };
    if (!body.actorAuthorization || !body.fundingAuthorization) {
      await db.collection("mandates").updateOne(
        { mandateId },
        { $setOnInsert: { mandateId, onchainMandateId, principalAgentId: agent.agentId, principalWallet: agent.walletAddress, mandate, mandateHash, policyHash, policy: mandate.policy, status: "DRAFT", createdAt: new Date() }, $set: { updatedAt: new Date() } },
        { upsert: true },
      );
      return Response.json({ mandateId, onchainMandateId, mandateHash, payloadHash, actorTypedData: actorTypedData(unsigned), fundingAuthorization: { standard: "EIP-3009", token: mandate.payment.tokenAddress, from: agent.walletAddress, to: process.env.MANDATE_ESCROW_ADDRESS, value: mandate.payment.amountAtomic, validAfter: "0", validBefore: unsigned.deadline, nonce: canonicalHash({ mandateId, type: "funding" }) } }, { status: 202 });
    }
    const actorAuthorization = body.actorAuthorization as ActorAuthorization;
    const valid = await verifyActorAuthorization(agent, actorAuthorization, { mandateId: onchainMandateId, action: actionHash("create"), payloadHash, nonce: actorNonce });
    if (!valid) throw new ApiError(403, "Invalid actor authorization");
    const started = await beginOperation(request, agent.agentId, "CREATE_MANDATE", canonicalHash(body));
    if (started.existing) return Response.json(started.operation);
    await db.collection("mandates").updateOne(
      { mandateId },
      { $set: { mandateId, onchainMandateId, principalAgentId: agent.agentId, principalWallet: agent.walletAddress, providerAgentId: mandate.providerAgentId ?? null, providerWallet: mandate.providerWallet ?? null, mandate, mandateHash, policyHash, policy: mandate.policy, actorAuthorization, fundingAuthorization: body.fundingAuthorization, status: "RELAY_PENDING", operationId: started.operation.operationId, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
    await db.collection("relayJobs").insertOne({ operationId: started.operation.operationId, type: "CREATE_MANDATE", mandateId, status: "PENDING", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() });
    return Response.json({ mandateId, operationId: started.operation.operationId, status: "RELAY_PENDING" }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
