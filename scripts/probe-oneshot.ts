import { writeFile } from "node:fs/promises";
import { encodeFunctionData, keccak256, stringToHex } from "viem";
import { relayStatus, relayTerminal, submitOneShot } from "../apps/web/lib/base-relay";

async function main() {
  const disputeRegistry = process.env.DISPUTE_REGISTRY_ADDRESS as `0x${string}` | undefined;
  if (!disputeRegistry) throw new Error("DISPUTE_REGISTRY_ADDRESS is required");
  const timestamp = new Date().toISOString();
  const mandateId = keccak256(stringToHex(`MANDATE_COURT_ONESHOT_PROBE:${timestamp}`));
  const transactionId = keccak256(stringToHex(`ONESHOT_PROBE_TX:${timestamp}`));
  const data = encodeFunctionData({
    abi: [{
      type: "function",
      name: "linkCase",
      stateMutability: "nonpayable",
      inputs: [{ name: "mandateId", type: "bytes32" }, { name: "transactionId", type: "bytes32" }],
      outputs: [],
    }],
    functionName: "linkCase",
    args: [mandateId, transactionId],
  });
  const submitted = await submitOneShot(disputeRegistry, data, `Mandate Court 1Shot probe ${timestamp}`);
  let status = await relayStatus(submitted.provider, submitted.taskId);
  for (let attempt = 0; attempt < 40 && !relayTerminal(status.taskState); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    status = await relayStatus(submitted.provider, submitted.taskId);
  }
  const result = { timestamp, mandateId, transactionId, submitted, status };
  await writeFile(".deployment/oneshot-probe.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (status.taskState !== "ExecSuccess") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
