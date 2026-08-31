import { createPublicClient, http, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { database } from "./db";

const registryAbi = [{
  type: "function",
  name: "getMandate",
  stateMutability: "view",
  inputs: [{ name: "mandateId", type: "bytes32" }],
  outputs: [{
    name: "mandate",
    type: "tuple",
    components: [
      { name: "principal", type: "address" },
      { name: "provider", type: "address" },
      { name: "mandateHash", type: "bytes32" },
      { name: "policyHash", type: "bytes32" },
      { name: "deliveryHash", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "acceptanceDeadline", type: "uint64" },
      { name: "deliveryDeadline", type: "uint64" },
      { name: "status", type: "uint8" },
    ],
  }],
}] as const;

const chainStatuses = ["NONE", "FUNDED", "OFFERED", "ACTIVE", "SUBMITTED", "UNDER_REVIEW", "FINALIZED", "SETTLED", "CANCELLED", "EXPIRED"];

function serializable(value: any): any {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_id").map(([key, item]) => [key, serializable(item)]));
  return value;
}

async function onchainMandate(onchainMandateId?: Hex) {
  const registry = process.env.MANDATE_REGISTRY_ADDRESS as Hex | undefined;
  const rpc = process.env.BASE_SEPOLIA_RPC_URL;
  if (!registry || !rpc || !onchainMandateId) return undefined;
  try {
    const client = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
    const result = await client.readContract({ address: registry, abi: registryAbi, functionName: "getMandate", args: [onchainMandateId] });
    return {
      principal: result.principal,
      provider: result.provider,
      mandateHash: result.mandateHash,
      policyHash: result.policyHash,
      deliveryHash: result.deliveryHash,
      amountAtomic: result.amount.toString(),
      acceptanceDeadline: new Date(Number(result.acceptanceDeadline) * 1000).toISOString(),
      deliveryDeadline: new Date(Number(result.deliveryDeadline) * 1000).toISOString(),
      status: chainStatuses[Number(result.status)] ?? `UNKNOWN_${result.status}`,
    };
  } catch {
    return undefined;
  }
}

export async function liveMandates(limit = 100, query: Record<string, unknown> = {}) {
  const db = await database();
  const records = await db.collection("mandates").find(query, { projection: { actorAuthorization: 0, fundingAuthorization: 0, acceptAuthorization: 0, deliveryAuthorization: 0, settlementAttestation: 0, manifest: 0, snapshots: 0, deliveryPreparation: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray();
  return Promise.all(records.map(async (record) => ({ ...serializable(record), onchain: await onchainMandate(record.onchainMandateId as Hex | undefined) })));
}

export async function publicResolvedCases(limit = 100) {
  const db = await database();
  const records = await db.collection("mandates").find(
    { status: { $in: ["FINALIZED", "SETTLEMENT_PENDING", "SETTLED"] }, judgmentHash: { $exists: true } },
    { projection: { _id: 0, actorAuthorization: 0, fundingAuthorization: 0, acceptAuthorization: 0, deliveryAuthorization: 0, settlementAttestation: 0, deliveryPreparation: 0, manifest: 0, snapshots: 0 } },
  ).sort({ finalizedAt: -1, updatedAt: -1 }).limit(limit).toArray();
  return Promise.all(records.map(async (record) => ({ ...serializable(record), onchain: await onchainMandate(record.onchainMandateId as Hex | undefined) })));
}

export async function publicResolvedCase(caseId: string) {
  const db = await database();
  const record = await db.collection("mandates").findOne(
    { $or: [{ caseId }, { mandateId: caseId }], status: { $in: ["FINALIZED", "SETTLEMENT_PENDING", "SETTLED"] }, judgmentHash: { $exists: true } },
    { projection: { _id: 0, actorAuthorization: 0, fundingAuthorization: 0, acceptAuthorization: 0, deliveryAuthorization: 0, settlementAttestation: 0, deliveryPreparation: 0 } },
  );
  if (!record) return undefined;
  return { ...serializable(record), onchain: await onchainMandate(record.onchainMandateId as Hex | undefined) };
}

export async function liveAgents(limit = 100) {
  const db = await database();
  return serializable(await db.collection("agents").find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray());
}

export async function liveRelayStats() {
  const db = await database();
  const [total, oneShot, gelato, failed] = await Promise.all([
    db.collection("relayJobs").countDocuments(),
    db.collection("relayJobs").countDocuments({ relayProvider: "1shot" }),
    db.collection("relayJobs").countDocuments({ relayProvider: "gelato" }),
    db.collection("relayJobs").countDocuments({ status: "FAILED" }),
  ]);
  return { total, oneShot, gelato, failed };
}
