import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export function canonicalHash(value: unknown) {
  return `0x${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function newApiKey() {
  return `mc_live_${randomBytes(32).toString("base64url")}`;
}

export function hashApiKey(apiKey: string) {
  return createHmac("sha256", env().API_KEY_PEPPER).update(apiKey).digest("hex");
}

export function safeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function identifier(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function secretKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

function webhookEncryptionSecret() {
  const config = env();
  return config.WEBHOOK_ENCRYPTION_KEY ?? config.API_KEY_PEPPER;
}

export function encryptWebhookSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(webhookEncryptionSecret()), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptWebhookSecret(value: string) {
  const [version, encodedIv, encodedTag, encodedCiphertext] = value.split(":");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedCiphertext) throw new Error("Invalid webhook secret ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", secretKey(webhookEncryptionSecret()), Buffer.from(encodedIv, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function webhookSignature(secret: string, timestamp: number, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhookSignature(input: { secret: string; timestamp: number; body: string; signature: string; toleranceSeconds?: number; nowSeconds?: number }) {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (Math.abs(now - input.timestamp) > tolerance) return false;
  return safeEqual(webhookSignature(input.secret, input.timestamp, input.body), input.signature);
}
