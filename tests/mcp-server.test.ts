import { afterEach, describe, expect, it, vi } from "vitest";
import { deliveryManifestSchema, mandateSchema } from "../packages/schemas/src/index";
import { configFromEnv, MCP_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from "../packages/mcp-server/src/config";
import { createSession, handleRequest } from "../packages/mcp-server/src/server";
import { loadSkills, resetSkillCache } from "../packages/mcp-server/src/skills";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC,
  MANDATE_CONSTRAINTS,
  MANIFEST_CONSTRAINTS,
  mandateTemplate,
  manifestTemplate,
} from "../packages/mcp-server/src/templates";
import { tools, toolsByName } from "../packages/mcp-server/src/tools";
import { createSigner, signActorAuthorization, signFundingAuthorization, WalletRequiredError } from "../packages/mcp-server/src/wallet";

afterEach(() => {
  vi.unstubAllGlobals();
  resetSkillCache();
});

const TEST_KEY = `0x${"11".repeat(32)}` as const;

function session(overrides: Record<string, unknown> = {}) {
  return createSession({ baseUrl: "https://mandate.example", ...overrides } as never);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function call(method: string, params?: unknown, courtSession = session()) {
  return handleRequest({ jsonrpc: "2.0", id: 1, method, params }, courtSession);
}

describe("MCP templates", () => {
  it("emits a mandate skeleton the real schema accepts", () => {
    const parsed = mandateSchema.safeParse(mandateTemplate());
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
  });

  it("weights the template criteria to exactly 10000 bps", () => {
    const total = mandateTemplate().acceptanceCriteria.reduce((sum, criterion) => sum + criterion.weightBps, 0);
    expect(total).toBe(10_000);
  });

  it("orders the template deadlines and names Base Sepolia USDC", () => {
    const template = mandateTemplate();
    expect(Date.parse(template.deliveryDeadline)).toBeGreaterThan(Date.parse(template.acceptanceDeadline));
    expect(Date.parse(template.acceptanceDeadline)).toBeGreaterThan(Date.now());
    expect(template.payment.chainId).toBe(BASE_SEPOLIA_CHAIN_ID);
    expect(template.payment.tokenAddress).toBe(BASE_SEPOLIA_USDC);
  });

  it("emits a manifest skeleton the real schema accepts, with and without prefilled ids", () => {
    for (const candidate of [manifestTemplate(), manifestTemplate("MC_abc123", "agent_provider_1")]) {
      const parsed = deliveryManifestSchema.safeParse(candidate);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
    }
  });

  it("maps every template artifact and evidence item to a criterion that exists", () => {
    const ids = new Set(mandateTemplate().acceptanceCriteria.map((criterion) => criterion.id));
    const manifest = manifestTemplate();
    const mapped = [...manifest.artifacts.flatMap((artifact) => artifact.criteria), ...manifest.evidence.flatMap((item) => item.supports)];
    expect(mapped.length).toBeGreaterThan(0);
    for (const id of mapped) expect(ids.has(id)).toBe(true);
  });

  it("ships constraint lists alongside both templates", () => {
    expect(MANDATE_CONSTRAINTS.length).toBeGreaterThan(0);
    expect(MANIFEST_CONSTRAINTS.length).toBeGreaterThan(0);
    expect(MANDATE_CONSTRAINTS.join(" ")).toContain("10000");
    expect(MANIFEST_CONSTRAINTS.join(" ")).toContain("0x");
  });
});

describe("MCP configuration", () => {
  it("defaults the base URL and treats absent credentials as read-only", () => {
    const config = configFromEnv({});
    expect(config.baseUrl).toBe("https://mandate-court.vercel.app");
    expect(config.apiKey).toBeUndefined();
    expect(config.privateKey).toBeUndefined();
    expect(config.privateKeyError).toBeUndefined();
  });

  it("records a malformed private key instead of throwing", () => {
    const config = configFromEnv({ AGENT_PRIVATE_KEY: "not-a-key" });
    expect(config.privateKey).toBeUndefined();
    expect(config.privateKeyError).toMatch(/64 hexadecimal/);
  });

  it("accepts a well-formed private key and trims the base URL", () => {
    const config = configFromEnv({ AGENT_PRIVATE_KEY: TEST_KEY, MANDATE_COURT_URL: " https://court.example " });
    expect(config.privateKey).toBe(TEST_KEY);
    expect(config.baseUrl).toBe("https://court.example");
  });
});

describe("MCP wallet signing", () => {
  const typedData = {
    domain: { name: "MandateCourt", version: "1", chainId: BASE_SEPOLIA_CHAIN_ID },
    types: { ActorIntent: [{ name: "action", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "ActorIntent",
    message: { action: "accept", nonce: 7n, deadline: 1_900_000_000n },
  };

  it("stringifies nonce and deadline and appends the signature, matching the CLI shape", async () => {
    const authorization = await signActorAuthorization(typedData, createSigner(TEST_KEY));
    expect(authorization.action).toBe("accept");
    expect(authorization.nonce).toBe("7");
    expect(authorization.deadline).toBe("1900000000");
    expect(authorization.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("splits the funding authorization into a token-ready v, r, s", async () => {
    const funding = {
      validAfter: "0",
      validBefore: "1900000000",
      nonce: `0x${"ab".repeat(32)}`,
      typedData: {
        domain: { name: "USDC", version: "2", chainId: BASE_SEPOLIA_CHAIN_ID, verifyingContract: BASE_SEPOLIA_USDC },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from: createSigner(TEST_KEY).address,
          to: BASE_SEPOLIA_USDC,
          value: 2_000_000n,
          validAfter: 0n,
          validBefore: 1_900_000_000n,
          nonce: `0x${"ab".repeat(32)}`,
        },
      },
    };
    const authorization = await signFundingAuthorization(funding, createSigner(TEST_KEY));
    expect(authorization.nonce).toBe(funding.nonce);
    expect(authorization.validBefore).toBe("1900000000");
    expect([27, 28]).toContain(authorization.v);
    expect(authorization.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(authorization.s).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses to sign without a wallet and names the remedy", () => {
    expect(() => session().signer()).toThrow(WalletRequiredError);
    expect(() => session({ privateKeyError: "AGENT_PRIVATE_KEY must be 0x followed by 64 hexadecimal characters" }).signer()).toThrow(/64 hexadecimal/);
  });
});

describe("MCP skills", () => {
  it("loads every protocol skill from the repository skills directory", () => {
    const { directory, skills } = loadSkills();
    expect(directory).toBeTruthy();
    const names = skills.map((skill) => skill.name);
    expect(names).toEqual(expect.arrayContaining([
      "mandate-court-evidence",
      "mandate-court-integration",
      "mandate-court-principal",
      "mandate-court-provider",
    ]));
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.text.length).toBeGreaterThan(200);
      expect(skill.text.startsWith("---")).toBe(false);
    }
  });

  it("falls through to the next candidate when an explicit directory does not exist", () => {
    const { directory, skills } = loadSkills("/nonexistent/mandate-court/skills-directory");
    expect(directory).not.toBe("/nonexistent/mandate-court/skills-directory");
    expect(skills.length).toBeGreaterThan(0);
  });
});

describe("MCP protocol dispatch", () => {
  it("advertises the protocol version, server identity, and all three capabilities", async () => {
    const response = await call("initialize");
    const result = response?.result as Record<string, never>;
    expect(response?.error).toBeUndefined();
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.serverInfo).toEqual({ name: SERVER_NAME, version: SERVER_VERSION });
    expect(Object.keys(result.capabilities)).toEqual(expect.arrayContaining(["tools", "resources", "prompts"]));
    expect(String(result.instructions)).toContain("A claim is never proof");
  });

  it("answers ping and returns nothing at all for notifications", async () => {
    expect((await call("ping"))?.result).toEqual({});
    expect(await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, session())).toBeUndefined();
    expect(await handleRequest({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }, session())).toBeUndefined();
  });

  it("suppresses responses to id-less requests even when the method is unknown", async () => {
    expect(await handleRequest({ jsonrpc: "2.0", method: "totally/unknown" }, session())).toBeUndefined();
  });

  it("rejects an unknown method with JSON-RPC -32601", async () => {
    const response = await call("does/not/exist");
    expect(response?.error?.code).toBe(-32601);
  });

  it("lists every tool with a name, a description, and an object input schema", async () => {
    const response = await call("tools/list");
    const listed = (response?.result as { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> }).tools;
    expect(listed).toHaveLength(tools.length);
    expect(listed.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "court_doctor",
      "authenticate",
      "list_docket",
      "inspect_mandate",
      "get_mandate_template",
      "get_manifest_template",
      "create_mandate",
      "accept_mandate",
      "submit_delivery",
      "appeal_case",
      "inspect_case",
      "wait_for_operation",
      "issue_webhook_secret",
    ]));
    for (const tool of listed) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
    }
    expect(new Set(listed.map((tool) => tool.name)).size).toBe(listed.length);
  });

  it("keeps every skill-referenced tool name resolvable", () => {
    for (const name of ["list_api_keys", "revoke_api_key", "link_identity", "export_reputation", "list_webhook_deliveries"]) {
      expect(toolsByName.has(name)).toBe(true);
    }
  });

  it("rejects an unknown tool with JSON-RPC -32601", async () => {
    const response = await call("tools/call", { name: "settle_case_immediately", arguments: {} });
    expect(response?.error?.code).toBe(-32601);
    expect(response?.error?.message).toContain("settle_case_immediately");
  });

  it("returns both text content and structuredContent on a successful call", async () => {
    const response = await call("tools/call", { name: "get_mandate_template", arguments: {} });
    const result = response?.result as { content: Array<{ type: string; text: string }>; structuredContent: { constraints: string[] } };
    expect(result.content[0].type).toBe("text");
    expect(mandateSchema.safeParse(JSON.parse(result.content[0].text).template).success).toBe(true);
    expect(result.structuredContent.constraints).toEqual(MANDATE_CONSTRAINTS);
  });

  it("prefills the manifest template from the tool arguments", async () => {
    const response = await call("tools/call", { name: "get_manifest_template", arguments: { mandateId: "MC_abc", providerAgentId: "agent_x" } });
    const template = (response?.result as { structuredContent: { template: Record<string, string> } }).structuredContent.template;
    expect(template.mandateId).toBe("MC_abc");
    expect(template.providerAgentId).toBe("agent_x");
  });

  it("reports a tool failure as isError content rather than a JSON-RPC error", async () => {
    const response = await call("tools/call", { name: "inspect_mandate", arguments: {} });
    const result = response?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(response?.error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ tool: "inspect_mandate", error: "mandateId is required" });
  });

  it("attaches an actionable hint to an HTTP failure from the Court", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Unauthorized" }, 401)));
    const response = await call("tools/call", { name: "list_api_keys", arguments: {} });
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.status).toBe(401);
    expect(payload.hint).toContain("authenticate");
  });

  it("tells a write tool's caller how to supply a wallet instead of failing opaquely", async () => {
    const response = await call("tools/call", { name: "accept_mandate", arguments: { mandateId: "MC_1" } });
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.remedy).toContain("AGENT_PRIVATE_KEY");
    expect(payload.remedy).toContain("never transmitted");
  });

  it("serves every skill as an MCP prompt", async () => {
    const listed = (await call("prompts/list"))?.result as { prompts: Array<{ name: string; description: string }> };
    expect(listed.prompts.map((prompt) => prompt.name)).toEqual(expect.arrayContaining(["mandate-court-evidence", "mandate-court-provider"]));

    const fetched = (await call("prompts/get", { name: "mandate-court-evidence" }))?.result as {
      description: string;
      messages: Array<{ role: string; content: { type: string; text: string } }>;
    };
    expect(fetched.messages[0].role).toBe("user");
    expect(fetched.messages[0].content.type).toBe("text");
    expect(fetched.messages[0].content.text).toContain("sha256");
  });

  it("rejects an unknown prompt with -32602 and names what is available", async () => {
    const response = await call("prompts/get", { name: "mandate-court-nonexistent" });
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toContain("mandate-court-provider");
  });

  it("lists resources and serves both schema resources without a network call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("schema resources must not hit the network");
    }));
    const listed = (await call("resources/list"))?.result as { resources: Array<{ uri: string; mimeType: string }> };
    expect(listed.resources.map((resource) => resource.uri)).toEqual([
      "court://docket",
      "court://agents",
      "court://schema/mandate",
      "court://schema/manifest",
      "court://health",
    ]);

    const mandateResource = (await call("resources/read", { uri: "court://schema/mandate" }))?.result as { contents: Array<{ uri: string; text: string }> };
    expect(mandateResource.contents[0].uri).toBe("court://schema/mandate");
    expect(mandateSchema.safeParse(JSON.parse(mandateResource.contents[0].text).template).success).toBe(true);

    const manifestResource = (await call("resources/read", { uri: "court://schema/manifest" }))?.result as { contents: Array<{ text: string }> };
    expect(deliveryManifestSchema.safeParse(JSON.parse(manifestResource.contents[0].text).template).success).toBe(true);
  });

  it("reads a live resource through the Court client", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ mandates: [], count: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await call("resources/read", { uri: "court://docket" });
    expect(JSON.parse((response?.result as { contents: Array<{ text: string }> }).contents[0].text)).toEqual({ mandates: [], count: 0 });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://mandate.example/api/v1/docket");
  });

  it("rejects an unknown resource URI with -32602", async () => {
    const response = await call("resources/read", { uri: "court://settlements" });
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toContain("court://docket");
  });
});

describe("MCP session behaviour", () => {
  it("reports credentials by presence only, never by value", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: "ok", version: "0.2.0" })));
    const response = await call("tools/call", { name: "court_doctor", arguments: {} }, session({ apiKey: "mc_live_secret", privateKey: TEST_KEY }));
    const text = (response?.result as { content: Array<{ text: string }> }).content[0].text;
    const doctor = JSON.parse(text);
    expect(doctor.credentials).toMatchObject({ apiKey: "configured", wallet: "configured" });
    expect(doctor.credentials.walletAddress).toBe(createSigner(TEST_KEY).address);
    expect(doctor.capabilities).toEqual({ reads: true, authenticatedReads: true, signedWrites: true });
    expect(doctor.skills.count).toBeGreaterThanOrEqual(4);
    expect(text).not.toContain("mc_live_secret");
    expect(text).not.toContain(TEST_KEY);
  });

  it("survives an unreachable Court so the operator can see why", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const response = await call("tools/call", { name: "court_doctor", arguments: {} });
    const doctor = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0].text);
    expect(doctor.healthError).toContain("ECONNREFUSED");
    expect(doctor.capabilities.signedWrites).toBe(false);
  });

  it("uses a newly minted API key for the rest of the session", async () => {
    const courtSession = session({ privateKey: TEST_KEY });
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/challenge")) return jsonResponse({ challengeId: "ch_1", message: "Sign in to Mandate Court: ch_1" });
      if (url.endsWith("/api/v1/api-keys")) return jsonResponse({ apiKey: "mc_live_minted", agentId: "agent_1" });
      return jsonResponse({ keys: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const authenticated = await call("tools/call", { name: "authenticate", arguments: { name: "Research Agent" } }, courtSession);
    const created = (authenticated?.result as { structuredContent: Record<string, string> }).structuredContent;
    expect(created.apiKey).toBe("mc_live_minted");
    expect(created.walletAddress).toBe(createSigner(TEST_KEY).address);
    expect(created.warning).toContain("will not return it again");
    expect(courtSession.hasApiKey).toBe(true);

    await call("tools/call", { name: "list_api_keys", arguments: {} }, courtSession);
    const authorization = (fetchMock.mock.calls.at(-1) as unknown[])[1] as { headers: Headers };
    expect(authorization.headers.get("authorization")).toBe("Bearer mc_live_minted");
  });

  it("builds the docket query from repeated skills and scalar filters", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ mandates: [], count: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await call("tools/call", { name: "list_docket", arguments: { skill: ["research", "python"], policy: "RESEARCH_DATA_V2", limit: 5, chainId: 84532 } });
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.getAll("skill")).toEqual(["research", "python"]);
    expect(url.searchParams.get("policy")).toBe("RESEARCH_DATA_V2");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("chainId")).toBe("84532");
  });

  it("omits absent filters rather than sending empty query parameters", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ mandates: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await call("tools/call", { name: "list_mandates", arguments: { status: "FUNDED", policy: "" } });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://mandate.example/api/v1/mandates?status=FUNDED");
  });

  it("signs and resubmits an acceptance in one call, reusing one idempotency key", async () => {
    const calls: Array<{ url: string; body: Record<string, never>; idempotencyKey: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init: { body?: string; headers: Headers }) => {
      const url = String(input);
      const body = JSON.parse(init.body ?? "{}");
      calls.push({ url, body, idempotencyKey: init.headers.get("idempotency-key") });
      if (!body.actorAuthorization) {
        return jsonResponse({
          actorTypedData: {
            domain: { name: "MandateCourt", version: "1", chainId: BASE_SEPOLIA_CHAIN_ID },
            types: { ActorIntent: [{ name: "action", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
            primaryType: "ActorIntent",
            message: { action: "accept", nonce: 0, deadline: 1_900_000_000 },
          },
        }, 428);
      }
      return jsonResponse({ status: "ACCEPTED", operationId: "op_1" });
    }));

    const response = await call("tools/call", { name: "accept_mandate", arguments: { mandateId: "MC_1" } }, session({ apiKey: "mc_live_test", privateKey: TEST_KEY }));
    const result = (response?.result as { structuredContent: Record<string, string> }).structuredContent;
    expect(result.status).toBe("ACCEPTED");
    expect(result.mandateId).toBe("MC_1");
    expect(calls).toHaveLength(2);
    expect(calls[0].idempotencyKey).toBe(calls[1].idempotencyKey);
    expect(calls[1].body.actorAuthorization.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(calls[1].body.actorAuthorization.nonce).toBe("0");
  });

  it("threads a caller-supplied idempotency key through both legs", async () => {
    const keys: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init: { body?: string; headers: Headers }) => {
      keys.push(init.headers.get("idempotency-key"));
      const body = JSON.parse(init.body ?? "{}");
      if (!body.actorAuthorization) {
        return jsonResponse({
          actorTypedData: { domain: {}, types: { ActorIntent: [{ name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }, primaryType: "ActorIntent", message: { nonce: 1, deadline: 2 } },
        }, 428);
      }
      return jsonResponse({ status: "ACCEPTED" });
    }));
    await call("tools/call", { name: "accept_mandate", arguments: { mandateId: "MC_1", idempotencyKey: "resume-me" } }, session({ apiKey: "mc_live_test", privateKey: TEST_KEY }));
    expect(keys).toEqual(["resume-me", "resume-me"]);
  });

  it("explains a missing preparation response instead of submitting an unsigned write", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ mandateId: "MC_1" })));
    const response = await call("tools/call", { name: "submit_delivery", arguments: { mandateId: "MC_1", manifest: manifestTemplate("MC_1", "agent_1") } }, session({ apiKey: "mc_live_test", privateKey: TEST_KEY }));
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0].text);
    expect(payload.error).toContain("get_manifest_template");
  });

  it("reports a wait timeout alongside the submission rather than as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init: { body?: string } = {}) => {
      const url = String(input);
      if (url.includes("/operations/")) return jsonResponse({ operation: { operationId: "op_1", status: "PENDING" }, jobs: [] });
      const body = JSON.parse(init.body ?? "{}");
      if (!body.actorAuthorization) {
        return jsonResponse({
          actorTypedData: { domain: {}, types: { ActorIntent: [{ name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }, primaryType: "ActorIntent", message: { nonce: 1, deadline: 2 } },
        }, 428);
      }
      return jsonResponse({ status: "APPEALED", operationId: "op_1" });
    }));
    const response = await call(
      "tools/call",
      { name: "appeal_case", arguments: { caseId: "MC_1", grounds: "C2 was scored FAIL against evidence source-registry, which resolves.", wait: true, timeoutSeconds: 5 } },
      session({ apiKey: "mc_live_test", privateKey: TEST_KEY }),
    );
    const result = (response?.result as { isError?: boolean; structuredContent: Record<string, unknown> });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.status).toBe("APPEALED");
    expect(result.structuredContent.operationWaitTimedOut).toBe(true);
    expect(String(result.structuredContent.note)).toContain("op_1");
  }, 20_000);

  it("clamps an out-of-range wait timeout instead of rejecting it", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ operation: { operationId: "op_1", status: "COMPLETED" }, jobs: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await call("tools/call", { name: "wait_for_operation", arguments: { operationId: "op_1", timeoutSeconds: 99_999 } });
    expect((response?.result as { structuredContent: { operation: { status: string } } }).structuredContent.operation.status).toBe("COMPLETED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("percent-encodes identifiers into read paths", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await call("tools/call", { name: "get_reputation", arguments: { agentId: "agent/../admin" } });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://mandate.example/api/v1/reputation/agent%2F..%2Fadmin");
  });
});
