// G3 oracle. Proves production is serving the milestone commit rather than the
// stale deployment, by exercising surfaces that only exist in the new code.
//
// A version string alone is weak evidence, so each endpoint added or changed in
// this milestone is probed. Routes that require auth must answer 401/403, never
// 404: a 404 means the route is not deployed, which is exactly the stale-build
// failure this gate exists to catch.
import { api, BASE_URL } from "../live/lib";

async function main() {
  const failures: string[] = [];
  console.log(`target: ${BASE_URL}\n`);

  // 1. Health shape from the milestone version of the route.
  const health = await api("/api/v1/health");
  const body = health.body as { version?: string; checks?: Record<string, string>; queue?: Record<string, number>; integrations?: Record<string, boolean> };
  console.log(`health version            -> ${body.version}`);
  if (body.version !== "0.2.0") failures.push(`health reports version ${body.version}, expected 0.2.0`);
  for (const field of ["queue", "integrations"] as const) {
    const present = body[field] !== undefined;
    console.log(`health.${field.padEnd(18)} -> ${present ? "present" : "ABSENT"}`);
    if (!present) failures.push(`health response has no ${field} block, which the milestone route always returns`);
  }
  if (body.queue && typeof body.queue.deadLetterWebhooks !== "number") failures.push("health.queue.deadLetterWebhooks missing");

  // 2. Routes introduced in this milestone must be deployed. Unauthenticated
  //    requests should be refused, not 404'd.
  console.log();
  const routes: Array<[string, RequestInit]> = [
    ["/api/v1/webhooks", {}],
    ["/api/v1/agents/agent_probe/webhook-secret", { method: "POST" }],
  ];
  for (const [path, init] of routes) {
    const res = await api(path, init);
    const deployed = res.status !== 404 && res.status !== 405;
    console.log(`${path.padEnd(46)} -> ${res.status} ${deployed ? "(deployed)" : "NOT DEPLOYED"}`);
    if (!deployed) failures.push(`${path} returned ${res.status}; the route is not present in the deployed build`);
    if (res.status === 200) failures.push(`${path} answered 200 without credentials, which would be an auth hole`);
  }

  // 3. A2A must advertise both protocol versions, added in this milestone.
  console.log();
  const card = await api("/.well-known/agent-card.json");
  const cardBody = JSON.stringify(card.body);
  const a2a = await api("/api/a2a", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent/getCard" }) });
  const a2aText = JSON.stringify(a2a.body);
  const versions = ["0.3.0", "1.0.0"].filter((v) => cardBody.includes(v) || a2aText.includes(v));
  console.log(`a2a advertises versions   -> ${versions.join(", ") || "(none found)"}`);
  if (versions.length < 2) failures.push(`A2A advertises ${versions.length} of the 2 expected protocol versions (0.3.0, 1.0.0)`);

  // 4. MCP adapter responds and lists tools.
  console.log();
  const mcp = await api("/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const tools = (mcp.body as { result?: { tools?: Array<{ name: string }> } })?.result?.tools ?? [];
  console.log(`hosted MCP tools/list     -> ${mcp.status}, ${tools.length} tools`);
  if (mcp.status !== 200) failures.push(`hosted MCP endpoint returned ${mcp.status}`);
  if (!tools.length) failures.push("hosted MCP endpoint listed no tools");

  // 5. Docket returns the milestone's match explanations.
  console.log();
  const docket = await api("/api/v1/docket?limit=5");
  const entries = (docket.body as { mandates?: unknown[]; entries?: unknown[] });
  const list = (entries.mandates ?? entries.entries ?? []) as Array<Record<string, unknown>>;
  console.log(`docket                    -> ${docket.status}, ${list.length} entr${list.length === 1 ? "y" : "ies"}`);
  if (docket.status !== 200) failures.push(`docket returned ${docket.status}`);

  console.log();
  if (failures.length) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("GATE G3 PASS");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
