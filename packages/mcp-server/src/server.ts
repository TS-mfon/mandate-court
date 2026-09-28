import { MandateCourtError } from "@mandate-court/sdk";
import { MCP_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, type ServerConfig } from "./config.js";
import { loadSkills } from "./skills.js";
import {
  MANDATE_CONSTRAINTS,
  MANIFEST_CONSTRAINTS,
  mandateTemplate,
  manifestTemplate,
} from "./templates.js";
import { CourtSession, tools, toolsByName } from "./tools.js";
import { WalletRequiredError } from "./wallet.js";

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const HTTP_HINTS: Record<number, string> = {
  401: "API key missing or invalid. Run authenticate, or set MANDATE_COURT_API_KEY.",
  403: "Wallet identity, scope, or signature mismatch. The API key's wallet must be the same wallet that signs.",
  404: "Unknown mandate, case, agent, or operation for this identity.",
  409: "Invalid lifecycle transition, closed appeal window, or a missing callbackUrl. Read the current state before retrying.",
  422: "Invalid JSON or schema. Validate against get_mandate_template or get_manifest_template.",
  428: "Signature preparation response. The tool should have signed and resubmitted; report this as a bug.",
  503: "Persistence or GenLayer is unavailable. Retry with backoff and check court_doctor for which dependency is down.",
};

const RESOURCES = [
  { uri: "court://docket", name: "Open docket", description: "Unassigned funded mandates a provider can accept, with match explanations.", mimeType: "application/json" },
  { uri: "court://agents", name: "Registered agents", description: "Agents registered with the Court and the skills, policies, and delivery types they advertise.", mimeType: "application/json" },
  { uri: "court://schema/mandate", name: "Mandate template and constraints", description: "A valid skeleton mandate plus every constraint the schema enforces.", mimeType: "application/json" },
  { uri: "court://schema/manifest", name: "Delivery manifest template and constraints", description: "A valid skeleton MDP manifest plus the evidence rules that decide the payout.", mimeType: "application/json" },
  { uri: "court://health", name: "Court health", description: "API and persistence readiness, queue depth, and integration status.", mimeType: "application/json" },
];

function errorPayload(error: unknown) {
  if (error instanceof MandateCourtError) {
    const body = error.body as Record<string, unknown> | null;
    return {
      message: `Mandate Court returned HTTP ${error.status}${body?.error ? `: ${String(body.error)}` : ""}`,
      data: { status: error.status, body: error.body, hint: HTTP_HINTS[error.status] },
    };
  }
  if (error instanceof WalletRequiredError) return { message: error.message, data: { remedy: "Set AGENT_PRIVATE_KEY in the MCP server environment. It is used only to sign typed data locally and is never transmitted." } };
  return { message: error instanceof Error ? error.message : String(error) };
}

const SKIP = Symbol("notification");

class MethodNotFound extends Error {}
class InvalidParams extends Error {}

/**
 * Dispatches one MCP JSON-RPC request. Returns `undefined` for notifications, which
 * must not receive a response.
 */
export async function handleRequest(request: JsonRpcRequest, session: CourtSession): Promise<JsonRpcResponse | undefined> {
  const isNotification = request.id === undefined || request.id === null;
  const id = (request.id ?? null) as string | number | null;
  const method = String(request.method ?? "");
  const params = (request.params ?? {}) as Record<string, unknown>;

  try {
    const result = await route(method, params, session);
    if (result === SKIP) return undefined;
    if (isNotification) return undefined;
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    if (isNotification) return undefined;
    const payload = errorPayload(error);
    const code = error instanceof MethodNotFound ? METHOD_NOT_FOUND : error instanceof InvalidParams ? INVALID_PARAMS : INTERNAL_ERROR;
    return { jsonrpc: "2.0", id, error: { code, message: payload.message, ...(payload.data ? { data: payload.data } : {}) } };
  }
}

async function route(method: string, params: Record<string, unknown>, session: CourtSession): Promise<unknown> {
  if (method === "initialize") {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        "Mandate Court adjudicates funded work between autonomous agents. Escrowed USDC is released by a judgment, not by hand. Read the mandate-court-provider or mandate-court-principal prompt for your role before acting, and mandate-court-evidence before submitting any delivery. Every write is wallet-signed and asynchronous: expect an operationId and poll it. A claim is never proof; only hash-matching public evidence mapped to acceptance criteria earns basis points.",
    };
  }
  if (method === "ping") return {};
  if (method.startsWith("notifications/")) return SKIP;

  if (method === "tools/list") {
    return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  }
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    const tool = toolsByName.get(name);
    if (!tool) throw new MethodNotFound(`Unsupported Mandate Court tool: ${name || "(missing name)"}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const value = await tool.handler(args, session);
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
    } catch (error) {
      const payload = errorPayload(error);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ tool: name, error: payload.message, ...(payload.data ?? {}) }, null, 2) }],
      };
    }
  }

  if (method === "resources/list") return { resources: RESOURCES };
  if (method === "resources/read") {
    const uri = String(params.uri ?? "");
    const value = await readResource(uri, session);
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
  }

  if (method === "prompts/list") {
    const { skills } = loadSkills(session.config.skillsDir);
    return { prompts: skills.map((skill) => ({ name: skill.name, description: skill.description })) };
  }
  if (method === "prompts/get") {
    const name = String(params.name ?? "");
    const { skills } = loadSkills(session.config.skillsDir);
    const skill = skills.find((candidate) => candidate.name === name);
    if (!skill) throw new InvalidParams(`Unknown Mandate Court prompt: ${name || "(missing name)"}. Available: ${skills.map((candidate) => candidate.name).join(", ") || "none"}`);
    return {
      description: skill.description,
      messages: [{ role: "user", content: { type: "text", text: skill.text } }],
    };
  }

  throw new MethodNotFound(`Unsupported MCP method: ${method || "(missing method)"}`);
}

async function readResource(uri: string, session: CourtSession): Promise<unknown> {
  if (uri === "court://docket") return session.client.listDocket();
  if (uri === "court://agents") return session.client.request("/api/v1/agents");
  if (uri === "court://health") return session.client.request("/api/v1/health");
  if (uri === "court://schema/mandate") return { template: mandateTemplate(), constraints: MANDATE_CONSTRAINTS };
  if (uri === "court://schema/manifest") return { template: manifestTemplate(), constraints: MANIFEST_CONSTRAINTS };
  throw new InvalidParams(`Unsupported Mandate Court resource: ${uri || "(missing uri)"}. Available: ${RESOURCES.map((resource) => resource.uri).join(", ")}`);
}

export function createSession(config: ServerConfig) {
  return new CourtSession(config);
}
