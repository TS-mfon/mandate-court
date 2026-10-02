// G4 oracle. Proves the mandate completed the full lifecycle AND that escrowed
// USDC actually reached the provider on Base Sepolia.
//
// A mandate.status of SETTLED is not accepted as evidence of payment. The oracle
// decodes the USDC Transfer events in the settlement transaction and requires a
// transfer to the provider wallet whose value equals the awarded amount derived
// from settlementBps, then confirms the provider's balance delta matches. A bug
// that marked a mandate settled without releasing funds would fail here.
import { decodeEventLog, parseAbiItem } from "viem";
import { api, currentRunId, loadState, publicClient, usdc, usdcBalance, USDC } from "../live/lib";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

async function main() {
  const failures: string[] = [];
  const runId = currentRunId();
  const state = loadState(runId) as Record<string, any>;

  const mandateId = state.mandateId as string;
  const provider = state.provider.address.toLowerCase() as string;
  const amountAtomic = BigInt(state.mandateDocument.payment.amountAtomic);
  console.log(`run       ${runId}`);
  console.log(`mandate   ${mandateId}`);
  console.log(`provider  ${provider}`);
  console.log(`escrowed  ${usdc(amountAtomic)}`);
  console.log();

  // --- 1. lifecycle reached settlement ------------------------------------
  const res = await api(`/api/v1/cases/${mandateId}`, { apiKey: state.providerApiKey as string });
  if (res.status !== 200) throw new Error(`case lookup returned ${res.status}`);
  const record = ((res.body as { case?: unknown }).case ?? res.body) as Record<string, any>;
  console.log(`status            ${record.status}`);
  if (record.status !== "SETTLED") failures.push(`mandate status is ${record.status}, expected SETTLED`);

  const judgment = record.judgment as Record<string, any> | undefined;
  if (!judgment) failures.push("case carries no judgment");
  console.log(`verdict           ${judgment?.verdict}`);
  console.log(`settlementBps     ${judgment?.settlementBps}`);
  console.log(`judgmentSource    ${record.judgmentSource}`);
  if (record.judgmentSource !== "GENLAYER_CONTRACT") failures.push(`judgmentSource is ${record.judgmentSource}, expected GENLAYER_CONTRACT`);

  const settlementBps = BigInt(judgment?.settlementBps ?? 0);
  if (settlementBps <= 0n) failures.push(`settlementBps is ${settlementBps}, so no award was made`);
  const expectedAward = (amountAtomic * settlementBps) / 10_000n;
  console.log(`expected award    ${usdc(expectedAward)}`);

  // Every criterion must have been scored, and every evidence item ruled on.
  const criteria = (judgment?.criteria ?? []) as Array<Record<string, any>>;
  const declared = state.mandateDocument.acceptanceCriteria.map((c: { id: string }) => c.id).sort();
  const scored = criteria.map((c) => c.id).sort();
  console.log(`criteria scored   ${scored.join(", ")} (declared ${declared.join(", ")})`);
  if (JSON.stringify(scored) !== JSON.stringify(declared)) failures.push(`judgment scored ${scored.join(",")} but the mandate declared ${declared.join(",")}`);

  const admissibility = (judgment?.admissibility ?? []) as Array<Record<string, any>>;
  const inadmissible = admissibility.filter((a) => a.status !== "ADMISSIBLE");
  console.log(`evidence ruled    ${admissibility.length} item(s), ${inadmissible.length} inadmissible`);

  // --- 2. every lifecycle stage has an on-chain transaction ---------------
  console.log();
  const stages: Array<[string, string]> = [
    ["create", record.createTransactionHash],
    ["accept", record.acceptTransactionHash],
    ["deliver", record.deliveryTransactionHash],
    ["link case", record.linkCaseTransactionHash],
    ["record accepted", record.acceptedRecordTransactionHash],
    ["record finalized", record.finalizedRecordTransactionHash],
    ["settlement", record.settlementTransactionHash],
  ];
  for (const [label, hash] of stages) {
    if (!hash) {
      console.log(`  ${label.padEnd(18)} MISSING`);
      failures.push(`${label} has no transaction hash`);
      continue;
    }
    const receipt = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null);
    const ok = receipt?.status === "success";
    console.log(`  ${label.padEnd(18)} ${ok ? "success" : "NOT CONFIRMED"}  block ${receipt?.blockNumber ?? "-"}  ${hash}`);
    if (!ok) failures.push(`${label} transaction ${hash} is not a confirmed success on Base Sepolia`);
  }

  // --- 3. the settlement transaction actually paid the provider -----------
  console.log();
  const settlementHash = record.settlementTransactionHash as `0x${string}`;
  const settlement = await publicClient.getTransactionReceipt({ hash: settlementHash });
  const transfers: Array<{ from: string; to: string; value: bigint }> = [];
  for (const logEntry of settlement.logs) {
    if (logEntry.address.toLowerCase() !== USDC.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: [TRANSFER], data: logEntry.data, topics: logEntry.topics });
      const args = decoded.args as unknown as { from: string; to: string; value: bigint };
      transfers.push({ from: args.from.toLowerCase(), to: args.to.toLowerCase(), value: args.value });
    } catch {
      // Not a Transfer event; ignore.
    }
  }
  console.log(`USDC Transfer events in the settlement tx: ${transfers.length}`);
  for (const t of transfers) console.log(`  ${t.from} -> ${t.to}  ${usdc(t.value)}`);

  const toProvider = transfers.filter((t) => t.to === provider);
  const paid = toProvider.reduce((sum, t) => sum + t.value, 0n);
  console.log(`paid to provider in that tx: ${usdc(paid)}`);
  if (!toProvider.length) failures.push("the settlement transaction contains no USDC transfer to the provider wallet");
  if (paid !== expectedAward) failures.push(`settlement paid ${usdc(paid)} to the provider but the judgment awarded ${usdc(expectedAward)}`);

  // --- 4. the provider's balance moved by that amount --------------------
  console.log();
  const before = BigInt(state.providerUsdcBefore ?? "0");
  const now = await usdcBalance(provider);
  const delta = now - before;
  console.log(`provider balance  ${usdc(before)} -> ${usdc(now)}  (delta ${usdc(delta)})`);
  if (delta !== expectedAward) failures.push(`provider balance moved by ${usdc(delta)}, expected ${usdc(expectedAward)}`);

  // --- 5. the principal's escrow actually left their wallet --------------
  const principalNow = await usdcBalance(state.principal.address);
  const principalFunded = 3_000_000n;
  console.log(`principal balance ${usdc(principalFunded)} funded -> ${usdc(principalNow)} now`);
  if (principalNow > principalFunded - amountAtomic) failures.push(`principal still holds ${usdc(principalNow)}; escrow does not appear to have been taken`);

  console.log();
  if (failures.length) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("GATE G4 PASS");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
