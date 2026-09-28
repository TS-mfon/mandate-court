export const SERVER_NAME = "mandate-court";
export const SERVER_VERSION = "0.2.0";
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const DEFAULT_BASE_URL = "https://mandate-court.vercel.app";

export type ServerConfig = {
  baseUrl: string;
  apiKey?: string;
  privateKey?: `0x${string}`;
  privateKeyError?: string;
  skillsDir?: string;
};

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Reads configuration from the environment. A malformed private key is recorded rather
 * than thrown so `court_doctor` can report it instead of the server failing to start.
 */
export function configFromEnv(env: Record<string, string | undefined> = process.env): ServerConfig {
  const rawKey = env.AGENT_PRIVATE_KEY?.trim();
  const config: ServerConfig = {
    baseUrl: env.MANDATE_COURT_URL?.trim() || DEFAULT_BASE_URL,
    apiKey: env.MANDATE_COURT_API_KEY?.trim() || undefined,
    skillsDir: env.MANDATE_COURT_SKILLS_DIR?.trim() || undefined,
  };
  if (rawKey && PRIVATE_KEY_PATTERN.test(rawKey)) config.privateKey = rawKey as `0x${string}`;
  else if (rawKey) config.privateKeyError = "AGENT_PRIVATE_KEY must be 0x followed by 64 hexadecimal characters";
  return config;
}
