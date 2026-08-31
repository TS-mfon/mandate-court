import { createGelatoEvmRelayerClient, StatusCode } from "@gelatocloud/gasless";
import { createCaveat, getSmartAccountsEnvironment, signDelegation } from "@metamask/smart-accounts-kit";
import { createExactExecutionTerms, ROOT_AUTHORITY } from "@metamask/delegation-core";
import { createPublicClient, encodeFunctionData, formatTransactionRequest, http, keccak256, stringToHex, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount, signAuthorization } from "viem/accounts";
import type { ActorAuthorization } from "./action-auth";

export type RelayProvider = "1shot" | "gelato";
export type RelaySubmission = { provider: RelayProvider; taskId: string; fallbackReason?: string };
export type RelayStatus = {
  provider: RelayProvider;
  taskId: string;
  taskState: "ExecPending" | "ExecSuccess" | "ExecReverted" | "Cancelled" | "CheckPending";
  transactionHash?: string;
  message?: string;
};

const actorComponents = [
  { name: "mandateId", type: "bytes32" },
  { name: "action", type: "bytes32" },
  { name: "payloadHash", type: "bytes32" },
  { name: "actor", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

const courtComponents = [
  { name: "mandateId", type: "bytes32" },
  { name: "action", type: "bytes32" },
  { name: "payloadHash", type: "bytes32" },
  { name: "actor", type: "address" },
  { name: "actorNonce", type: "uint256" },
  { name: "courtNonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

const registryAbi = [
  { type: "function", name: "courtNonce", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "createMandate", stateMutability: "nonpayable", outputs: [],
    inputs: [
      { name: "actorIntent", type: "tuple", components: actorComponents },
      { name: "courtAuthorization", type: "tuple", components: courtComponents },
      { name: "actorSignature", type: "bytes" },
      { name: "courtSignature", type: "bytes" },
      { name: "provider", type: "address" },
      { name: "mandateHash", type: "bytes32" },
      { name: "policyHash", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "acceptanceDeadline", type: "uint64" },
      { name: "deliveryDeadline", type: "uint64" },
      { name: "fundingAuthorization", type: "tuple", components: [
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" }, { name: "v", type: "uint8" },
        { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
      ] },
    ],
  },
  {
    type: "function", name: "acceptMandate", stateMutability: "nonpayable", outputs: [],
    inputs: [
      { name: "actorIntent", type: "tuple", components: actorComponents },
      { name: "courtAuthorization", type: "tuple", components: courtComponents },
      { name: "actorSignature", type: "bytes" }, { name: "courtSignature", type: "bytes" },
    ],
  },
  {
    type: "function", name: "submitDelivery", stateMutability: "nonpayable", outputs: [],
    inputs: [
      { name: "actorIntent", type: "tuple", components: actorComponents },
      { name: "courtAuthorization", type: "tuple", components: courtComponents },
      { name: "actorSignature", type: "bytes" }, { name: "courtSignature", type: "bytes" },
      { name: "deliveryHash", type: "bytes32" },
    ],
  },
] as const;

const settlementAbi = [
  {
    type: "function",
    name: "executeFinalJudgment",
    stateMutability: "nonpayable",
    outputs: [],
    inputs: [
      {
        name: "judgment",
        type: "tuple",
        components: [
          { name: "mandateId", type: "bytes32" },
          { name: "mandateHash", type: "bytes32" },
          { name: "deliveryHash", type: "bytes32" },
          { name: "genlayerTransactionId", type: "bytes32" },
          { name: "verdictHash", type: "bytes32" },
          { name: "providerBps", type: "uint16" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "attestation", type: "bytes" },
    ],
  },
] as const;

const disputeAbi = [
  { type: "function", name: "linkCase", stateMutability: "nonpayable", inputs: [{ name: "mandateId", type: "bytes32" }, { name: "transactionId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "recordAccepted", stateMutability: "nonpayable", inputs: [{ name: "mandateId", type: "bytes32" }, { name: "verdictHash", type: "bytes32" }], outputs: [] },
  { type: "function", name: "recordAppeal", stateMutability: "nonpayable", inputs: [{ name: "mandateId", type: "bytes32" }, { name: "appellant", type: "address" }, { name: "principal", type: "bool" }, { name: "groundsHash", type: "bytes32" }], outputs: [] },
  { type: "function", name: "recordFinalized", stateMutability: "nonpayable", inputs: [{ name: "mandateId", type: "bytes32" }, { name: "verdictHash", type: "bytes32" }], outputs: [] },
] as const;

const erc20Abi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

type OneShotCapability = {
  feeCollector: Address;
  targetAddress: Address;
  tokens: Array<{ address: Address; symbol: string; decimals: string }>;
};

type OneShotExecution = { target: Address; value: "0x0"; data: Hex };

function config() {
  const registry = process.env.MANDATE_REGISTRY_ADDRESS as `0x${string}` | undefined;
  const privateKey = process.env.COURT_SIGNER_PRIVATE_KEY as `0x${string}` | undefined;
  const rpc = process.env.BASE_SEPOLIA_RPC_URL;
  if (!registry || !privateKey || !rpc) throw new Error("Base relay environment is incomplete");
  return { registry, account: privateKeyToAccount(privateKey), rpc };
}

function relayer() {
  const apiKey = process.env.GELATO_RELAY_API_KEY;
  if (!apiKey) throw new Error("Gelato fallback unavailable: API key missing");
  return createGelatoEvmRelayerClient({ apiKey, testnet: true });
}

async function oneShotRpc(method: string, params: unknown) {
  const url = process.env.ONESHOT_RELAYER_URL || "https://relayer.1shotapi.dev/relayers";
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`1Shot returned HTTP ${response.status}`);
  const body = await response.json() as { result?: unknown; error?: { message?: string; data?: unknown } };
  if (body.error) throw new Error(`1Shot: ${body.error.message ?? "relay error"}`);
  return body.result;
}

async function oneShotCapability() {
  const capabilities = await oneShotRpc("relayer_getCapabilities", [String(baseSepolia.id)]) as Record<string, OneShotCapability>;
  const capability = capabilities[String(baseSepolia.id)];
  if (!capability?.targetAddress || !capability.feeCollector) throw new Error("1Shot does not advertise Base Sepolia execution");
  const configuredUsdc = process.env.BASE_USDC_ADDRESS?.toLowerCase();
  const usdc = capability.tokens?.find((token) => token.symbol === "USDC" && token.address.toLowerCase() === configuredUsdc);
  if (!usdc) throw new Error("1Shot does not advertise the configured Base Sepolia USDC");
  return { ...capability, usdc: usdc.address };
}

async function signedOneShotTransactions(executions: OneShotExecution[], delegate: Address) {
  const privateKey = process.env.COURT_SIGNER_PRIVATE_KEY as Hex;
  const { account, rpc } = config();
  const environment = getSmartAccountsEnvironment(baseSepolia.id);
  const transactions = await Promise.all(executions.map(async (execution) => {
    const caveat = createCaveat(
      environment.caveatEnforcers.ExactExecutionEnforcer,
      createExactExecutionTerms({ execution: { target: execution.target, value: 0n, callData: execution.data } }),
    );
    const unsigned = {
      delegate,
      delegator: account.address,
      authority: ROOT_AUTHORITY,
      caveats: [caveat],
      salt: keccak256(stringToHex(crypto.randomUUID())),
      signature: "0x" as Hex,
    };
    const signature = await signDelegation({
      privateKey,
      delegation: { delegate: unsigned.delegate, delegator: unsigned.delegator, authority: unsigned.authority, caveats: unsigned.caveats, salt: unsigned.salt },
      delegationManager: environment.DelegationManager,
      chainId: baseSepolia.id,
    });
    return { permissionContext: [{ ...unsigned, signature }], executions: [execution] };
  }));
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
  const authorization = await signAuthorization({
    privateKey,
    address: environment.implementations.EIP7702StatelessDeleGatorImpl,
    chainId: baseSepolia.id,
    nonce,
  });
  return { transactions, authorizationList: formatTransactionRequest({ authorizationList: [authorization] }).authorizationList };
}

export async function submitOneShot(to: Address, data: Hex, memo: string): Promise<RelaySubmission> {
  const capability = await oneShotCapability();
  const feeTransfer = (amount: bigint): OneShotExecution => ({
    target: capability.usdc,
    value: "0x0",
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [capability.feeCollector, amount] }),
  });
  const work: OneShotExecution = { target: to, value: "0x0", data };
  const initialPermission = await signedOneShotTransactions([feeTransfer(1_000_000n), work], capability.targetAddress);
  const initialEstimate = await oneShotRpc("relayer_estimate7710Transaction", {
    chainId: String(baseSepolia.id),
    transactions: initialPermission.transactions,
    authorizationList: initialPermission.authorizationList,
  }) as { success?: boolean; requiredPaymentAmount?: string; error?: string };
  if (initialEstimate.success === false) throw new Error(`1Shot estimate failed: ${initialEstimate.error ?? "unknown error"}`);
  if (!initialEstimate.requiredPaymentAmount) throw new Error("1Shot estimate returned no required payment amount");
  const permission = await signedOneShotTransactions([feeTransfer(BigInt(initialEstimate.requiredPaymentAmount)), work], capability.targetAddress);
  const payload = { chainId: String(baseSepolia.id), transactions: permission.transactions, authorizationList: permission.authorizationList };
  const estimate = await oneShotRpc("relayer_estimate7710Transaction", payload) as { success?: boolean; context?: string; error?: string };
  if (estimate.success === false) throw new Error(`1Shot final estimate failed: ${estimate.error ?? "unknown error"}`);
  if (!estimate.context) throw new Error("1Shot final estimate returned no context");
  const requestedTaskId = keccak256(stringToHex(`${memo}:${crypto.randomUUID()}`));
  const result = await oneShotRpc("relayer_send7710Transaction", { ...payload, context: estimate.context, taskId: requestedTaskId, memo: memo.slice(0, 256) });
  const taskId = typeof result === "string" ? result : (result as { taskId?: string; id?: string })?.taskId ?? (result as { id?: string })?.id;
  if (!taskId) throw new Error("1Shot returned no task ID");
  return { provider: "1shot", taskId };
}

async function submitGelato(to: `0x${string}`, data: Hex, fallbackReason?: string): Promise<RelaySubmission> {
  if (!process.env.GELATO_RELAY_API_KEY) throw new Error(`Gelato fallback unavailable: ${fallbackReason ?? "API key missing"}`);
  return { provider: "gelato", taskId: await relayer().sendTransaction({ chainId: 84532, to, data }), fallbackReason };
}

async function submitRelay(to: `0x${string}`, data: Hex, memo: string): Promise<RelaySubmission> {
  try {
    return await submitOneShot(to, data, memo);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return submitGelato(to, data, reason);
  }
}

async function courtAuthorization(actor: ActorAuthorization) {
  const { registry, account, rpc } = config();
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
  const courtNonce = (await client.readContract({ address: registry, abi: registryAbi, functionName: "courtNonce" })) as bigint;
  const authorization = {
    mandateId: actor.mandateId,
    action: actor.action,
    payloadHash: actor.payloadHash,
    actor: actor.actor,
    actorNonce: BigInt(actor.nonce),
    courtNonce,
    deadline: BigInt(actor.deadline),
  };
  const signature = await account.signTypedData({
    domain: { name: "Mandate Court", version: "1", chainId: 84532, verifyingContract: registry },
    types: {
      CourtAuthorization: [
        { name: "mandateId", type: "bytes32" },
        { name: "action", type: "bytes32" },
        { name: "payloadHash", type: "bytes32" },
        { name: "actor", type: "address" },
        { name: "actorNonce", type: "uint256" },
        { name: "courtNonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "CourtAuthorization",
    message: authorization,
  });
  return { authorization, signature };
}

function actorIntent(actor: ActorAuthorization) {
  return {
    mandateId: actor.mandateId,
    action: actor.action,
    payloadHash: actor.payloadHash,
    actor: actor.actor,
    nonce: BigInt(actor.nonce),
    deadline: BigInt(actor.deadline),
  };
}

export async function relayCreate(mandate: Record<string, any>) {
  const { registry } = config();
  const actor = mandate.actorAuthorization as ActorAuthorization;
  const court = await courtAuthorization(actor);
  const funding = mandate.fundingAuthorization;
  const data = encodeFunctionData({
    abi: registryAbi,
    functionName: "createMandate",
    args: [
      actorIntent(actor),
      court.authorization,
      actor.signature,
      court.signature,
      (mandate.providerWallet ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
      mandate.mandateHash,
      mandate.policyHash,
      BigInt(mandate.mandate.payment.amountAtomic),
      BigInt(Math.floor(new Date(mandate.mandate.acceptanceDeadline).getTime() / 1000)),
      BigInt(Math.floor(new Date(mandate.mandate.deliveryDeadline).getTime() / 1000)),
      {
        validAfter: BigInt(funding.validAfter),
        validBefore: BigInt(funding.validBefore),
        nonce: funding.nonce,
        v: Number(funding.v),
        r: funding.r,
        s: funding.s,
      },
    ],
  } as any);
  return submitRelay(registry, data, `Mandate Court create ${mandate.mandateId}`);
}

export async function relayAccept(mandate: Record<string, any>) {
  const { registry } = config();
  const actor = mandate.acceptAuthorization as ActorAuthorization;
  const court = await courtAuthorization(actor);
  const data = encodeFunctionData({ abi: registryAbi, functionName: "acceptMandate", args: [actorIntent(actor), court.authorization, actor.signature, court.signature] } as any);
  return submitRelay(registry, data, `Mandate Court accept ${mandate.mandateId}`);
}

export async function relayDelivery(mandate: Record<string, any>) {
  const { registry } = config();
  const actor = mandate.deliveryAuthorization as ActorAuthorization;
  const court = await courtAuthorization(actor);
  const data = encodeFunctionData({ abi: registryAbi, functionName: "submitDelivery", args: [actorIntent(actor), court.authorization, actor.signature, court.signature, mandate.deliveryHash] } as any);
  return submitRelay(registry, data, `Mandate Court delivery ${mandate.mandateId}`);
}

export async function relaySettlement(mandate: Record<string, any>, nonce: bigint) {
  const { account } = config();
  const adapter = process.env.SETTLEMENT_ADAPTER_ADDRESS as `0x${string}` | undefined;
  if (!adapter) throw new Error("SETTLEMENT_ADAPTER_ADDRESS is not configured");
  const judgment = {
    mandateId: mandate.onchainMandateId as `0x${string}`,
    mandateHash: mandate.mandateHash as `0x${string}`,
    deliveryHash: mandate.deliveryHash as `0x${string}`,
    genlayerTransactionId: mandate.genlayerTransactionId as `0x${string}`,
    verdictHash: mandate.judgmentHash as `0x${string}`,
    providerBps: Number(mandate.judgment.settlementBps),
    nonce,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };
  const attestation = await account.signTypedData({
    domain: { name: "Mandate Court Final Judgment", version: "1", chainId: 84532, verifyingContract: adapter },
    types: {
      FinalJudgment: [
        { name: "mandateId", type: "bytes32" },
        { name: "mandateHash", type: "bytes32" },
        { name: "deliveryHash", type: "bytes32" },
        { name: "genlayerTransactionId", type: "bytes32" },
        { name: "verdictHash", type: "bytes32" },
        { name: "providerBps", type: "uint16" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "FinalJudgment",
    message: judgment,
  });
  const data = encodeFunctionData({
    abi: settlementAbi,
    functionName: "executeFinalJudgment",
    args: [judgment, attestation],
  });
  const relay = await submitRelay(adapter, data, `Mandate Court settlement ${mandate.mandateId}`);
  return { ...relay, judgment, attestation };
}

function disputeRegistry() {
  const address = process.env.DISPUTE_REGISTRY_ADDRESS as `0x${string}` | undefined;
  if (!address) throw new Error("DISPUTE_REGISTRY_ADDRESS is not configured");
  return address;
}

export function relayLinkCase(mandate: Record<string, any>) {
  const target = disputeRegistry();
  const data = encodeFunctionData({ abi: disputeAbi, functionName: "linkCase", args: [mandate.onchainMandateId, mandate.genlayerTransactionId] });
  return submitRelay(target, data, `Mandate Court link case ${mandate.mandateId}`);
}

export function relayRecordAppeal(mandate: Record<string, any>, appeal: Record<string, any>) {
  const target = disputeRegistry();
  const data = encodeFunctionData({
    abi: disputeAbi,
    functionName: "recordAppeal",
    args: [mandate.onchainMandateId, appeal.walletAddress, appeal.role === "principal", keccak256(stringToHex(String(appeal.grounds)))],
  });
  return submitRelay(target, data, `Mandate Court record appeal ${appeal.appealId}`);
}

export function relayRecordAccepted(mandate: Record<string, any>) {
  const target = disputeRegistry();
  const verdictHash = mandate.acceptedJudgmentHash ?? mandate.judgmentHash;
  if (!verdictHash) throw new Error("Accepted judgment hash is unavailable");
  const data = encodeFunctionData({ abi: disputeAbi, functionName: "recordAccepted", args: [mandate.onchainMandateId, verdictHash] });
  return submitRelay(target, data, `Mandate Court accept verdict ${mandate.mandateId}`);
}

export function relayRecordFinalized(mandate: Record<string, any>) {
  const target = disputeRegistry();
  const data = encodeFunctionData({ abi: disputeAbi, functionName: "recordFinalized", args: [mandate.onchainMandateId, mandate.judgmentHash] });
  return submitRelay(target, data, `Mandate Court finalize case ${mandate.mandateId}`);
}

async function gelatoStatus(taskId: string): Promise<RelayStatus> {
  const status = await relayer().getStatus({ id: taskId });
  const transactionHash = "receipt" in status
    ? "transactionHash" in status.receipt
      ? status.receipt.transactionHash
      : status.receipt.receipt.transactionHash
    : undefined;
  if (status.status === StatusCode.Success) return { provider: "gelato", taskId, taskState: "ExecSuccess", transactionHash };
  if (status.status === StatusCode.Reverted) return { provider: "gelato", taskId, taskState: "ExecReverted", transactionHash, message: status.message };
  if (status.status === StatusCode.Rejected) return { provider: "gelato", taskId, taskState: "Cancelled", message: status.message };
  if (status.status === StatusCode.Submitted) return { provider: "gelato", taskId, taskState: "ExecPending", transactionHash: status.hash };
  return { provider: "gelato", taskId, taskState: "CheckPending" };
}

async function oneShotStatus(taskId: string): Promise<RelayStatus> {
  const result = await oneShotRpc("relayer_getStatus", { id: taskId, logs: false }) as Record<string, any>;
  const raw = String(result.status ?? "");
  const transactionHash = result.receipt?.transactionHash ?? result.hash ?? result.txHash ?? result.transactionHash;
  if (raw === "200" || raw.toLowerCase() === "confirmed") return { provider: "1shot", taskId, taskState: "ExecSuccess", transactionHash };
  if (raw === "400" || raw.toLowerCase() === "rejected") return { provider: "1shot", taskId, taskState: "Cancelled", message: result.message ?? result.error };
  if (raw === "500" || raw.toLowerCase() === "reverted") return { provider: "1shot", taskId, taskState: "ExecReverted", transactionHash, message: result.message ?? result.error };
  return { provider: "1shot", taskId, taskState: raw === "110" ? "ExecPending" : "CheckPending", transactionHash };
}

export function relayStatus(provider: RelayProvider, taskId: string) {
  return provider === "1shot" ? oneShotStatus(taskId) : gelatoStatus(taskId);
}

export function relayTerminal(taskState: string) {
  return ["ExecSuccess", "ExecReverted", "Cancelled"].includes(taskState);
}
