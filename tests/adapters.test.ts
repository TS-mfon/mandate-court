import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  database: vi.fn(),
  env: vi.fn(() => ({ NEXT_PUBLIC_APP_URL: "https://mandate.example" })),
  apiError: vi.fn((error: unknown) => Response.json({ error: error instanceof Error ? error.message : "error" }, { status: 500 })),
  invokeCanonicalAction: vi.fn(),
  invokeCanonicalOperation: vi.fn(),
  adapterActionResult: vi.fn((action: string, identifier: string | undefined, invocation: { status: number; body: unknown }) => ({
    action,
    identifier: identifier ?? null,
    status: invocation.status,
    accepted: invocation.status >= 200 && invocation.status < 300,
    preparationRequired: invocation.status === 428,
    body: invocation.body,
  })),
  readGenLayerCase: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ database: mocks.database }));
vi.mock("@/lib/env", () => ({ env: mocks.env }));
vi.mock("@/lib/auth", () => ({ ApiError: class ApiError extends Error {}, apiError: mocks.apiError }));
vi.mock("@/lib/adapter-actions", () => ({
  adapterActionResult: mocks.adapterActionResult,
  invokeCanonicalAction: mocks.invokeCanonicalAction,
  invokeCanonicalOperation: mocks.invokeCanonicalOperation,
}));
vi.mock("@/lib/public-projections", () => ({ mandatePublicCaseProjection: {}, mandateSummaryProjection: {} }));
vi.mock("@/lib/genlayer", () => ({ readGenLayerCase: mocks.readGenLayerCase }));

function collection(overrides: Record<string, unknown> = {}) {
  return {
    findOne: vi.fn(async () => null),
    find: vi.fn(() => ({
      sort: vi.fn(() => ({
        limit: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
      })),
      limit: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
    })),
    ...overrides,
  };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://mandate.example/api/adapter", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("A2A adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.env.mockReturnValue({ NEXT_PUBLIC_APP_URL: "https://mandate.example" });
    mocks.apiError.mockImplementation((error: unknown) => Response.json({ error: error instanceof Error ? error.message : "error" }, { status: 500 }));
  });

  it("advertises both supported protocol versions", async () => {
    const { GET } = await import("../apps/web/app/api/a2a/route");
    const response = await GET();
    const body = await response.json();
    expect(body.protocolVersion).toBe("1.0.0");
    expect(body.supportedProtocolVersions).toEqual(["0.3.0", "1.0.0"]);
    expect(body.skills).toContain("poll-operation");
  });

  it("lists docket tasks without exposing private authorization fields", async () => {
    const mandate = { mandateId: "MC-1", status: "OPEN", operationId: "op-1" };
    const mandates = collection({
      find: vi.fn(() => ({
        sort: vi.fn(() => ({
          limit: vi.fn(() => ({ toArray: vi.fn(async () => [mandate]) })),
        })),
      })),
    });
    mocks.database.mockResolvedValue({ collection: vi.fn(() => mandates) });
    const { POST } = await import("../apps/web/app/api/a2a/route");
    const response = await POST(request({ jsonrpc: "2.0", id: 1, method: "tasks/list", params: { limit: 1 } }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.result.tasks[0]).toMatchObject({ id: "MC-1", status: { state: "open" } });
    expect(body.result.tasks[0]).not.toHaveProperty("actorAuthorization");
  });

  it("forwards signed actions and preserves the caller idempotency key", async () => {
    const mandate = { mandateId: "MC-1", status: "FUNDED" };
    const mandates = collection({ findOne: vi.fn(async () => mandate) });
    mocks.database.mockResolvedValue({ collection: vi.fn(() => mandates) });
    mocks.invokeCanonicalAction.mockResolvedValue({ status: 428, body: { actorTypedData: { primaryType: "ActorIntent" } }, headers: new Headers() });
    const { POST } = await import("../apps/web/app/api/a2a/route");
    const response = await POST(request({ jsonrpc: "2.0", id: 2, method: "tasks/send", params: { action: "accept", mandateId: "MC-1", idempotencyKey: "a2a-idem-1", body: {} } }, { authorization: "Bearer mc_live_test" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.result.action.preparationRequired).toBe(true);
    expect(mocks.invokeCanonicalAction).toHaveBeenCalledWith(expect.any(Request), "accept", "MC-1", {}, { idempotencyKey: "a2a-idem-1" });
  });

  it("returns canonical authorization failures as JSON-RPC errors", async () => {
    const mandates = collection({ findOne: vi.fn(async () => ({ mandateId: "MC-1", status: "FUNDED" })) });
    mocks.database.mockResolvedValue({ collection: vi.fn(() => mandates) });
    mocks.invokeCanonicalAction.mockResolvedValue({ status: 403, body: { error: "Invalid actor authorization" }, headers: new Headers() });
    const { POST } = await import("../apps/web/app/api/a2a/route");
    const response = await POST(request({ jsonrpc: "2.0", id: 3, method: "tasks/send", params: { action: "accept", mandateId: "MC-1", body: {} } }));
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.message).toBe("Invalid actor authorization");
  });

  it("polls operations through the queue-aware canonical endpoint", async () => {
    mocks.invokeCanonicalOperation.mockResolvedValue({ status: 200, body: { operation: { operationId: "op-1", status: "COMPLETED" }, jobs: [] }, headers: new Headers() });
    const { POST } = await import("../apps/web/app/api/a2a/route");
    const response = await POST(request({ jsonrpc: "2.0", id: 4, method: "operations/get", params: { operationId: "op-1" } }, { authorization: "Bearer mc_live_test" }));
    const body = await response.json();
    expect(body.result.operation.status).toBe("COMPLETED");
    expect(mocks.invokeCanonicalOperation).toHaveBeenCalledWith(expect.any(Request), "op-1");
  });
});

describe("MCP adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.env.mockReturnValue({ NEXT_PUBLIC_APP_URL: "https://mandate.example" });
    mocks.apiError.mockImplementation((error: unknown) => Response.json({ error: error instanceof Error ? error.message : "error" }, { status: 500 }));
  });

  it("lists signed action tools and appeal tools", async () => {
    const { POST } = await import("../apps/web/app/api/mcp/route");
    const response = await POST(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const body = await response.json();
    const names = body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["prepare_accept", "submit_delivery", "prepare_appeal", "submit_appeal", "get_operation"]));
  });

  it("prepares an appeal through the canonical REST validator", async () => {
    mocks.database.mockResolvedValue({ collection: vi.fn(() => collection()) });
    mocks.invokeCanonicalAction.mockResolvedValue({ status: 428, body: { actorTypedData: { primaryType: "ActorIntent" } }, headers: new Headers() });
    const { POST } = await import("../apps/web/app/api/mcp/route");
    const response = await POST(request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "prepare_appeal", arguments: { caseId: "MC-1", grounds: "The locked criterion was interpreted incorrectly.", idempotencyKey: "mcp-idem-1" } } }, { authorization: "Bearer mc_live_test" }));
    const body = await response.json();
    const result = JSON.parse(body.result.content[0].text);
    expect(response.status).toBe(200);
    expect(result.preparationRequired).toBe(true);
    expect(mocks.invokeCanonicalAction).toHaveBeenCalledWith(expect.any(Request), "appeal", "MC-1", { grounds: "The locked criterion was interpreted incorrectly." }, { idempotencyKey: "mcp-idem-1" });
  });

  it("returns finalized GenLayer reasoning for case inspection", async () => {
    const mandates = collection({ findOne: vi.fn(async () => ({ mandateId: "MC-1", judgmentHash: "0xabc", status: "SETTLED" })) });
    mocks.database.mockResolvedValue({ collection: vi.fn(() => mandates) });
    mocks.readGenLayerCase.mockResolvedValue({ judgment: { verdict: "FULFILLED", summary: "All criteria passed" }, finalized: true });
    const { POST } = await import("../apps/web/app/api/mcp/route");
    const response = await POST(request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "inspect_case", arguments: { caseId: "MC-1" } } }));
    const body = await response.json();
    const result = JSON.parse(body.result.content[0].text);
    expect(result.judgmentSource).toBe("GENLAYER_CONTRACT");
    expect(result.judgment.summary).toBe("All criteria passed");
  });
});
