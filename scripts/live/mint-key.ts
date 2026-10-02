// Mints an API key against the live deployment by signing the wallet challenge,
// exactly as `court auth login` does. Used both to capture the pre-rotation
// control key for gate G2 and to create the run's agent keys after rotation.
//
//   npx tsx scripts/live/mint-key.ts <privateKey> "<name>"
import { api, must, walletFor } from "./lib";

async function main() {
  const [privateKey, name] = process.argv.slice(2);
  if (!privateKey || !name) throw new Error("usage: mint-key.ts <privateKey> <name>");
  const { account } = walletFor(privateKey);

  const challenge = must(await api("/api/v1/auth/challenge", { method: "POST", body: JSON.stringify({ walletAddress: account.address }) }), "createChallenge") as {
    challengeId: string;
    message: string;
  };
  const signature = await account.signMessage({ message: challenge.message });
  const created = must(
    await api("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ challengeId: challenge.challengeId, signature, name }) }),
    "createApiKey",
  ) as Record<string, unknown>;

  console.log(JSON.stringify({ walletAddress: account.address, ...created }, null, 2));
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
