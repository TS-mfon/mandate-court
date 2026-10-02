// Step 1 of the live run: fund the principal wallet with test USDC from the
// court signer, then mint an API key and publish a profile for both agents.
//
// The principal needs USDC but no ETH: escrow is locked with an EIP-3009
// transferWithAuthorization, which the principal only signs while the court
// relays it and pays the gas. The provider needs neither.
import { api, currentRunId, envFile, loadState, log, must, publicClient, saveState, usdc, usdcBalance, USDC, USDC_ABI, walletFor } from "./lib";

const FUND_ATOMIC = 3_000_000n; // 3 USDC, enough for one 2 USDC mandate plus headroom.

async function mintKey(privateKey: string, name: string) {
  const { account } = walletFor(privateKey);
  const challenge = must(
    await api("/api/v1/auth/challenge", { method: "POST", body: JSON.stringify({ walletAddress: account.address }) }),
    "createChallenge",
  ) as { challengeId: string; message: string };
  const signature = await account.signMessage({ message: challenge.message });
  const created = must(
    await api("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ challengeId: challenge.challengeId, signature, name }) }),
    "createApiKey",
  ) as { apiKey: string; agentId: string; keyId: string };
  return created;
}

async function main() {
  const runId = currentRunId();
  const state = loadState(runId);
  const env = envFile();
  const principal = state.principal as { privateKey: string; address: string };
  const provider = state.provider as { privateKey: string; address: string };

  // --- fund the principal --------------------------------------------------
  const before = await usdcBalance(principal.address);
  log(`principal ${principal.address} holds ${usdc(before)}`);
  if (before < 2_000_000n) {
    const court = walletFor(env.COURT_SIGNER_PRIVATE_KEY);
    const courtBalance = await usdcBalance(court.account.address);
    log(`court signer holds ${usdc(courtBalance)}, sending ${usdc(FUND_ATOMIC)}`);
    if (courtBalance < FUND_ATOMIC) throw new Error(`court signer has only ${usdc(courtBalance)}`);
    const hash = await court.client.writeContract({
      address: USDC,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [principal.address as `0x${string}`, FUND_ATOMIC],
    });
    log(`funding tx ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    log(`funding ${receipt.status} in block ${receipt.blockNumber}`);
    if (receipt.status !== "success") throw new Error("funding transfer reverted");
    saveState(runId, { fundingTx: hash });
  } else {
    log("principal already funded, skipping transfer");
  }
  const after = await usdcBalance(principal.address);
  log(`principal now holds ${usdc(after)}`);

  // --- register both agents ------------------------------------------------
  const principalKey = await mintKey(principal.privateKey, "USGS Pilot Principal");
  log(`principal agent ${principalKey.agentId}`);
  const providerKey = await mintKey(provider.privateKey, "USGS Pilot Provider");
  log(`provider agent  ${providerKey.agentId}`);

  must(
    await api("/api/v1/agents", {
      method: "POST",
      apiKey: principalKey.apiKey,
      body: JSON.stringify({
        walletAddress: principal.address,
        name: "Seismic Data Principal",
        description: "Commissions verifiable public seismic datasets for downstream risk models.",
        skills: ["research"],
        supportedPolicies: ["RESEARCH_DATA_V2"],
        deliveryTypes: ["dataset"],
      }),
    }),
    "register principal",
  );

  must(
    await api("/api/v1/agents", {
      method: "POST",
      apiKey: providerKey.apiKey,
      body: JSON.stringify({
        walletAddress: provider.address,
        name: "Seismic Data Provider",
        description: "Collects earthquake records from the USGS public catalog and publishes them with per-record source citations.",
        skills: ["research", "python"],
        supportedPolicies: ["RESEARCH_DATA_V2"],
        deliveryTypes: ["dataset"],
      }),
    }),
    "register provider",
  );

  saveState(runId, {
    principalApiKey: principalKey.apiKey,
    principalAgentId: principalKey.agentId,
    providerApiKey: providerKey.apiKey,
    providerAgentId: providerKey.agentId,
    principalUsdcBefore: after.toString(),
  });
  log("both agents registered");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
