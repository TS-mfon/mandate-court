import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
