// Prints the value of specific non-secret Vercel env keys so configuration can
// be verified. Pass keys as argv. Refuses to print anything that looks like a
// credential so a transcript cannot leak one by accident.
import { PROJECT_ID, vercel } from "./vercel-api";

const DENY = /PRIVATE_KEY|PEPPER|SECRET|MONGODB_URI|API_KEY/i;

type EnvRow = { key: string; value?: string; target?: string[]; type: string };

async function main() {
  const keys = process.argv.slice(2);
  const { envs } = (await vercel(`/v10/projects/${PROJECT_ID}/env?decrypt=true`)) as { envs: EnvRow[] };
  for (const key of keys) {
    const rows = envs.filter((e) => e.key === key);
    if (!rows.length) {
      console.log(`${key} -> ABSENT`);
      continue;
    }
    for (const row of rows) {
      const shown = DENY.test(key) ? `<redacted, len ${row.value?.length ?? 0}>` : row.value;
      console.log(`${key} [${(row.target ?? []).join("+")}] (${row.type}) -> ${shown}`);
    }
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
