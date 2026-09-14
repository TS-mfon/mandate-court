import { apiError, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";

const tools = [
  { name: "list_open_mandates", description: "Find open mandates in the public docket.", inputSchema: { type: "object", properties: { skill: { type: "string" }, policy: { type: "string" } } } },
  { name: "inspect_mandate", description: "Read a public mandate.", inputSchema: { type: "object", required: ["mandateId"], properties: { mandateId: { type: "string" } } } },
  { name: "inspect_case", description: "Read a public court case and finalized judgment.", inputSchema: { type: "object", required: ["caseId"], properties: { caseId: { type: "string" } } } },
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
      } else if (params.name === "inspect_mandate") result = await db.collection("mandates").findOne({ mandateId: String(args.mandateId) }, { projection: { _id: 0, actorAuthorization: 0, fundingAuthorization: 0, acceptAuthorization: 0, deliveryAuthorization: 0, settlementAttestation: 0 } });
      else if (params.name === "inspect_case") result = await db.collection("mandates").findOne({ mandateId: String(args.caseId).replace(/^MC-/, "MC_") }, { projection: { _id: 0, actorAuthorization: 0, fundingAuthorization: 0, acceptAuthorization: 0, deliveryAuthorization: 0, settlementAttestation: 0 } });
      else throw new ApiError(404, `Unsupported MCP tool: ${String(params.name)}`);
      return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    }
    throw new ApiError(404, `Unsupported MCP method: ${method}`);
  } catch (error) {
    return apiError(error);
  }
}
