import { apiError, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { env } from "@/lib/env";
import { mandatePublicCaseProjection, mandateSummaryProjection } from "@/lib/public-projections";
import { adapterActionResult, invokeCanonicalAction, invokeCanonicalOperation, type AdapterAction } from "@/lib/adapter-actions";
import { readGenLayerCase } from "@/lib/genlayer";

export const runtime = "nodejs";

const tools = [
  { name: "list_open_mandates", description: "Find open mandates in the public docket.", inputSchema: { type: "object", properties: { skill: { type: "string" }, policy: { type: "string" } } } },
  { name: "inspect_mandate", description: "Read a public mandate.", inputSchema: { type: "object", required: ["mandateId"], properties: { mandateId: { type: "string" } } } },
  { name: "inspect_case", description: "Read a public court case and finalized judgment.", inputSchema: { type: "object", required: ["caseId"], properties: { caseId: { type: "string" } } } },
  { name: "prepare_accept", description: "Prepare wallet typed data for accepting a mandate.", inputSchema: { type: "object", required: ["mandateId"], properties: { mandateId: { type: "string" } } } },
  { name: "submit_accept", description: "Submit a wallet-signed mandate acceptance.", inputSchema: { type: "object", required: ["mandateId", "actorAuthorization"], properties: { mandateId: { type: "string" }, actorAuthorization: { type: "object" } } } },
  { name: "prepare_delivery", description: "Prepare a delivery manifest and wallet typed data.", inputSchema: { type: "object", required: ["mandateId", "manifest"], properties: { mandateId: { type: "string" }, manifest: { type: "object" } } } },
  { name: "submit_delivery", description: "Submit a wallet-signed delivery manifest.", inputSchema: { type: "object", required: ["mandateId", "manifest", "deliveryHash", "actorAuthorization"], properties: { mandateId: { type: "string" }, manifest: { type: "object" }, deliveryHash: { type: "string" }, actorAuthorization: { type: "object" } } } },
  { name: "prepare_appeal", description: "Prepare wallet typed data for appealing a judgment.", inputSchema: { type: "object", required: ["caseId", "grounds"], properties: { caseId: { type: "string" }, grounds: { type: "string" }, idempotencyKey: { type: "string" } } } },
  { name: "submit_appeal", description: "Submit a wallet-signed appeal against a judgment.", inputSchema: { type: "object", required: ["caseId", "grounds", "actorAuthorization"], properties: { caseId: { type: "string" }, grounds: { type: "string" }, actorAuthorization: { type: "object" }, idempotencyKey: { type: "string" } } } },
  { name: "get_operation", description: "Read an authenticated asynchronous operation.", inputSchema: { type: "object", required: ["operationId"], properties: { operationId: { type: "string" } } } },
];

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const method = String(body.method ?? "");
    if (method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { protocolVersion: "2025-06-18", serverInfo: { name: "mandate-court", version: "0.1.0" }, capabilities: { tools: {}, resources: {} } } });
    if (method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { tools } });
    if (method === "resources/list") return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { resources: [{ uri: "court://docket", name: "Open docket" }, { uri: "court://agents", name: "Registered agents" }] } });
    if (method === "resources/read") {
      const uri = String((body.params as Record<string, unknown> | undefined)?.uri ?? "");
      const db = await database();
      let value: unknown;
      if (uri === "court://docket") value = await db.collection("mandates").find({ status: { $in: ["OPEN", "FUNDED"] }, $or: [{ providerAgentId: null }, { providerAgentId: "" }] }, { projection: { _id: 0, mandateId: 1, policy: 1, status: 1, mandate: 1 } }).limit(50).toArray();
      else if (uri === "court://agents") value = await db.collection("agents").find({}, { projection: { _id: 0, agentId: 1, name: 1, description: 1, skills: 1, supportedPolicies: 1, deliveryTypes: 1, erc8004: 1 } }).limit(100).toArray();
      else throw new ApiError(404, `Unsupported MCP resource: ${uri}`);
      return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }] } });
    }
    if (method === "tools/call") {
      const params = (body.params ?? {}) as Record<string, unknown>;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const db = await database();
      let result: unknown;
      if (params.name === "list_open_mandates") {
        const query: Record<string, unknown> = { status: { $in: ["OPEN", "FUNDED"] }, $or: [{ providerAgentId: null }, { providerAgentId: "" }] };
        if (args.skill) query["mandate.requiredSkills"] = String(args.skill);
        if (args.policy) query.policy = String(args.policy);
        result = await db.collection("mandates").find(query, { projection: { _id: 0, mandateId: 1, policy: 1, status: 1, mandate: 1 } }).limit(50).toArray();
      } else if (params.name === "inspect_mandate") result = await db.collection("mandates").findOne({ mandateId: String(args.mandateId) }, { projection: mandateSummaryProjection });
      else if (params.name === "inspect_case") {
        const mandate = await db.collection("mandates").findOne({ $or: [{ caseId: String(args.caseId) }, { mandateId: String(args.caseId).replace(/^MC-/, "MC_") }] }, { projection: mandatePublicCaseProjection });
        if (!mandate) throw new ApiError(404, "Case not found");
        if (!mandate.judgmentHash) throw new ApiError(409, "Case has no finalized judgment");
        const genlayerCase = await readGenLayerCase(String(mandate.mandateId), mandate.genlayerContractAddress ? String(mandate.genlayerContractAddress) : undefined);
        result = { ...mandate, judgment: genlayerCase.judgment, genlayerCase, judgmentSource: "GENLAYER_CONTRACT" };
      }
      else if (params.name === "get_operation") {
        const operationId = String(args.operationId ?? "");
        if (!operationId) throw new ApiError(422, "operationId is required");
        const invocation = await invokeCanonicalOperation(request, operationId);
        if (invocation.status >= 400) throw new ApiError(invocation.status, String((invocation.body as Record<string, unknown> | null)?.error ?? "Operation lookup failed"), invocation.body);
        result = invocation.body;
      } else if (["prepare_accept", "submit_accept", "prepare_delivery", "submit_delivery", "prepare_appeal", "submit_appeal"].includes(String(params.name))) {
        const name = String(params.name);
        const action: AdapterAction = name.includes("accept") ? "accept" : name.includes("delivery") ? "deliver" : "appeal";
        const identifier = action === "appeal" ? String(args.caseId ?? "") : String(args.mandateId ?? "");
        if (!identifier) throw new ApiError(422, action === "appeal" ? "caseId is required" : "mandateId is required");
        const actionBody = action === "accept"
          ? (name.startsWith("prepare") ? {} : { actorAuthorization: args.actorAuthorization })
          : action === "deliver"
            ? { manifest: args.manifest, ...(name.startsWith("prepare") ? {} : { deliveryHash: args.deliveryHash, actorAuthorization: args.actorAuthorization }) }
            : { grounds: args.grounds, ...(name.startsWith("prepare") ? {} : { actorAuthorization: args.actorAuthorization }) };
        const invocation = await invokeCanonicalAction(request, action, identifier, actionBody, { idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined });
        result = adapterActionResult(action, identifier, invocation);
        if (invocation.status >= 400 && invocation.status !== 428) throw new ApiError(invocation.status, String((invocation.body as Record<string, unknown> | null)?.error ?? "MCP action failed"), invocation.body);
      }
      else throw new ApiError(404, `Unsupported MCP tool: ${String(params.name)}`);
      return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    }
    throw new ApiError(404, `Unsupported MCP method: ${method}`);
  } catch (error) {
    return apiError(error);
  }
}
