import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { DeliveryManifest } from "@mandate-court/schemas";

const MAX_ITEM_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;

function privateAddress(address: string) {
  if (isIP(address) === 4) {
    return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  }
  return address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:");
}

async function assertPublicUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("Evidence must use HTTPS");
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.some(({ address }) => privateAddress(address))) throw new Error("Private network evidence is forbidden");
  return url;
}

async function fetchPublicEvidence(rawUrl: string, signal: AbortSignal) {
  let url = await assertPublicUrl(rawUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { "user-agent": "MandateCourt-Snapshot/1.0" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects === MAX_REDIRECTS) throw new Error(`Evidence exceeded ${MAX_REDIRECTS} redirects`);
    const location = response.headers.get("location");
    if (!location) throw new Error("Evidence redirect omitted Location header");
    url = await assertPublicUrl(new URL(location, url).toString());
  }
  throw new Error("Evidence redirect resolution failed");
}

async function readBoundedBody(response: Response) {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_ITEM_BYTES) throw new Error(`Evidence exceeds ${MAX_ITEM_BYTES} bytes`);
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ITEM_BYTES) throw new Error(`Evidence exceeds ${MAX_ITEM_BYTES} bytes`);
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export async function snapshotManifest(manifest: DeliveryManifest) {
  const items = [...manifest.artifacts, ...manifest.evidence];
  const snapshots = [];
  for (const item of items) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetchPublicEvidence(item.url, controller.signal);
      const buffer = await readBoundedBody(response);
      const sha256 = `0x${createHash("sha256").update(buffer).digest("hex")}`;
      snapshots.push({
        id: item.id,
        originalUrl: item.url,
        finalUrl: response.url,
        status: response.status,
        contentType: response.headers.get("content-type"),
        contentLength: buffer.length,
        sha256,
        committedSha256: item.sha256,
        hashMatches: sha256.toLowerCase() === item.sha256.toLowerCase(),
        retrievedAt: new Date().toISOString(),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  return snapshots;
}
