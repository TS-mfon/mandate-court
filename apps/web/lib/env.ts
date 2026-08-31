import { z } from "zod";

const schema = z.object({
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().default("mandate_court"),
  API_KEY_PEPPER: z.string().min(24),
  COURT_SIGNER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  WEBHOOK_SIGNING_SECRET: z.string().min(24).optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
});

export function env() {
  return schema.parse(process.env);
}
