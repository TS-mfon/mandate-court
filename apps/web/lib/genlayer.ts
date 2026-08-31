import { createAccount, createClient } from "genlayer-js";
import { canonicalJson } from "./crypto";
import { studionet } from "genlayer-js/chains";
import { ExecutionResult, TransactionStatus } from "genlayer-js/types";

function client() {
  const privateKey = process.env.GENLAYER_OPERATOR_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) throw new Error("GENLAYER_OPERATOR_PRIVATE_KEY is not configured");
  return createClient({ chain: studionet, endpoint: process.env.GENLAYER_RPC_URL, account: createAccount(privateKey) });
}

export async function submitAdjudication(mandate: Record<string, any>) {
  const address = process.env.GENLAYER_CONTRACT_ADDRESS as `0x${string}` | undefined;
  if (!address) throw new Error("GENLAYER_CONTRACT_ADDRESS is not configured");
  return client().writeContract({
    address,
    functionName: "submit_case",
    args: [
      mandate.mandateId,
      canonicalJson({ mandateId: mandate.mandateId, ...mandate.mandate }),
      canonicalJson({ manifest: mandate.manifest, snapshots: mandate.snapshots }),
      mandate.mandateHash,
      mandate.deliveryHash,
      mandate.policy,
    ],
    value: 0n,
  });
}

export async function judgmentProgress(transactionId: `0x${string}`, mandateId: string) {
  const address = process.env.GENLAYER_CONTRACT_ADDRESS as `0x${string}` | undefined;
  if (!address) throw new Error("GENLAYER_CONTRACT_ADDRESS is not configured");
  const court = client();
  const receipt = await court.getTransaction({ hash: transactionId as any });
  const status = String(receipt.statusName ?? receipt.status).toUpperCase();
  const finalized = status === TransactionStatus.FINALIZED.toUpperCase();
  const accepted = status === TransactionStatus.ACCEPTED.toUpperCase();
  let stored: unknown;
  if (accepted || finalized) {
    try {
      stored = await court.readContract({ address, functionName: "get_case", args: [mandateId], jsonSafeReturn: true });
    } catch {
      stored = undefined;
    }
  }
  if (!finalized) return { status, accepted, finalized: false, receipt, stored };
  if (receipt.txExecutionResultName !== ExecutionResult.FINISHED_WITH_RETURN) {
    throw new Error(`GenLayer execution finalized with ${receipt.txExecutionResultName}`);
  }
  if (!stored) stored = await court.readContract({ address, functionName: "get_case", args: [mandateId], jsonSafeReturn: true });
  return { status, accepted, finalized: true, receipt, stored };
}

export const finalizedJudgment = judgmentProgress;

export async function appealJudgment(transactionId: `0x${string}`) {
  const court = client();
  if (!(await court.canAppeal({ txId: transactionId }))) throw new Error("GenLayer transaction cannot currently be appealed");
  const value = await court.getMinAppealBond({ txId: transactionId });
  return court.appealTransaction({ txId: transactionId, value });
}
