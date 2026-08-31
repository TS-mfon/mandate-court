import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbiParameters, stringToHex, verifyTypedData } from "viem";
import { baseSepolia } from "viem/chains";
import type { AuthenticatedAgent } from "./auth";

const actions = {
  create: keccak256(stringToHex("CREATE_MANDATE")),
  accept: keccak256(stringToHex("ACCEPT_MANDATE")),
  submit: keccak256(stringToHex("SUBMIT_DELIVERY")),
  appeal: keccak256(stringToHex("APPEAL_CASE")),
} as const;

export type ActorAuthorization = {
  mandateId: `0x${string}`;
  action: `0x${string}`;
  payloadHash: `0x${string}`;
  actor: `0x${string}`;
  nonce: string;
  deadline: string;
  signature: `0x${string}`;
};

export function actionHash(action: keyof typeof actions) {
  return actions[action];
}

export function mandateIdHash(mandateId: string) {
  return keccak256(stringToHex(mandateId));
}

export function createPayloadHash(input: {
  provider: `0x${string}`;
  mandateHash: `0x${string}`;
  policyHash: `0x${string}`;
  amount: bigint;
  acceptanceDeadline: bigint;
  deliveryDeadline: bigint;
}) {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address, bytes32, bytes32, uint256, uint64, uint64"),
      [input.provider, input.mandateHash, input.policyHash, input.amount, input.acceptanceDeadline, input.deliveryDeadline],
    ),
  );
}

export function acceptPayloadHash(mandateId: `0x${string}`, provider: `0x${string}`) {
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32, address"), [mandateId, provider]));
}

export function deliveryPayloadHash(mandateId: `0x${string}`, deliveryHash: `0x${string}`) {
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32"), [mandateId, deliveryHash]));
}

export function appealPayloadHash(mandateId: `0x${string}`, grounds: string, appellant: `0x${string}`) {
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32, address"), [mandateId, keccak256(stringToHex(grounds)), appellant]));
}

export async function currentActorNonce(actor: `0x${string}`) {
  const registry = process.env.MANDATE_REGISTRY_ADDRESS as `0x${string}` | undefined;
  const rpc = process.env.BASE_SEPOLIA_RPC_URL;
  if (!registry || !rpc) throw new Error("Actor nonce configuration is incomplete");
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
  return client.readContract({
    address: registry,
    abi: [{ type: "function", name: "actorNonces", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] }],
    functionName: "actorNonces",
    args: [actor],
  });
}

export function actorTypedData(authorization: Omit<ActorAuthorization, "signature">) {
  const verifyingContract = process.env.MANDATE_REGISTRY_ADDRESS as `0x${string}` | undefined;
  if (!verifyingContract) throw new Error("MANDATE_REGISTRY_ADDRESS is not configured");
  return {
    domain: { name: "Mandate Court", version: "1", chainId: 84532, verifyingContract },
    types: {
      ActorIntent: [
        { name: "mandateId", type: "bytes32" },
        { name: "action", type: "bytes32" },
        { name: "payloadHash", type: "bytes32" },
        { name: "actor", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "ActorIntent" as const,
    message: {
      ...authorization,
      nonce: BigInt(authorization.nonce),
      deadline: BigInt(authorization.deadline),
    },
  };
}

export async function verifyActorAuthorization(
  agent: AuthenticatedAgent,
  authorization: ActorAuthorization,
  expected: { mandateId: `0x${string}`; action: `0x${string}`; payloadHash: `0x${string}`; nonce?: bigint },
) {
  if (
    authorization.actor.toLowerCase() !== agent.walletAddress.toLowerCase() ||
    authorization.mandateId !== expected.mandateId ||
    authorization.action !== expected.action ||
    authorization.payloadHash !== expected.payloadHash ||
    (expected.nonce !== undefined && BigInt(authorization.nonce) !== expected.nonce) ||
    BigInt(authorization.deadline) < BigInt(Math.floor(Date.now() / 1000))
  ) {
    return false;
  }
  return verifyTypedData({
    ...actorTypedData(authorization),
    address: agent.walletAddress,
    signature: authorization.signature,
  });
}
