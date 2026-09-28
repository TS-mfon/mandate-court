import { apiError, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { env } from "@/lib/env";
import { mandateSummaryProjection } from "@/lib/public-projections";
import { adapterActionResult, invokeCanonicalAction, invokeCanonicalOperation, type AdapterAction } from "@/lib/adapter-actions";

export const runtime = "nodejs";

function taskFromMandate(mandate: Record<string, unknown>) {
  return {
    id: String(mandate.mandateId),
    status: { state: String(mandate.status).toLowerCase() },
    metadata: { protocol: "mandate-court/1.1", operationId: mandate.operationId ?? null },
    artifacts: [{ name: "mandate", url: `${env().NEXT_PUBLIC_APP_URL}/api/v1/mandates/${mandate.mandateId}`, mimeType: "application/json" }],
  };
}

const adapterActions = new Set<AdapterAction>(["create", "claim", "accept", "deliver", "appeal"]);

function requestedAction(value: unknown): AdapterAction | undefined {
  const action = String(value ?? "");
  return adapterActions.has(action as AdapterAction) ? action as AdapterAction : undefined;
}

function adapterIdempotencyKey(params: Record<string, unknown>) {
  const metadata = params.metadata as Record<string, unknown> | undefined;
  const value = params.idempotencyKey ?? metadata?.idempotencyKey;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function GET() {
  return Response.json({
    protocolVersion: "1.0.0",
    supportedProtocolVersions: ["0.3.0", "1.0.0"],
    name: "Mandate Court A2A Gateway",
    description: "A2A adapter for funded mandates, delivery, adjudication, appeals, and settlement.",
    url: `${env().NEXT_PUBLIC_APP_URL}/api/a2a`,
    capabilities: { streaming: false, pushNotifications: true },
    skills: ["create-mandate", "discover-mandates", "claim-mandate", "accept-mandate", "submit-delivery", "inspect-case", "poll-operation", "appeal-judgment"],
    documentationUrl: `${env().NEXT_PUBLIC_APP_URL}/docs#a2a`,
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const method = String(body.method ?? "");
    const params = (body.params ?? {}) as Record<string, unknown>;
    const idempotencyKey = adapterIdempotencyKey(params);
    if (method === "operations/get") {
      const operationId = String(params.operationId ?? params.id ?? "");
      if (!operationId) throw new ApiError(422, "operationId is required");
      const invocation = await invokeCanonicalOperation(request, operationId);
      if (invocation.status >= 400) {
        return Response.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: invocation.status, message: (invocation.body as Record<string, unknown> | null)?.error ?? "Operation lookup failed" } }, { status: invocation.status });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: invocation.body });
    }
    if (method === "tasks/get") {
      const db = await database();
      const mandate = await db.collection("mandates").findOne({ mandateId: String(params.id) }, { projection: mandateSummaryProjection });
      if (!mandate) throw new ApiError(404, "Task not found");
      return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: taskFromMandate(mandate as Record<string, unknown>) });
    }
    if (method === "tasks/list") {
      const db = await database();
      const status = params.status ? String(params.status).toUpperCase() : undefined;
      const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 100);
      const query: Record<string, unknown> = status ? { status } : { status: { $in: ["OPEN", "FUNDED", "ACTIVE", "SUBMITTED", "UNDER_REVIEW", "FINALIZED", "SETTLED"] } };
      if (params.policy) query.policy = String(params.policy);
      const mandates = await db.collection("mandates").find(query, { projection: mandateSummaryProjection }).sort({ createdAt: -1 }).limit(Number.isFinite(limit) ? limit : 50).toArray();
      return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { tasks: mandates.map((mandate) => taskFromMandate(mandate as Record<string, unknown>)) } });
    }
    if (method === "tasks/send") {
      const action = params.action === undefined ? undefined : requestedAction(params.action);
      if (params.action !== undefined && !action) throw new ApiError(422, "Unsupported A2A action");
      if (action === "create") {
        const invocation = await invokeCanonicalAction(request, action, undefined, params.body ?? params.input ?? {}, { idempotencyKey });
        const result = adapterActionResult(action, undefined, invocation);
        if (invocation.status >= 400 && invocation.status !== 428) {
          return Response.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: invocation.status, message: (invocation.body as Record<string, unknown> | null)?.error ?? "A2A action failed", data: result } }, { status: invocation.status });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result });
      }
      const mandateId = String(params.mandateId ?? "");
      if (!mandateId) throw new ApiError(422, "mandateId is required");
      const db = await database();
      const mandate = await db.collection("mandates").findOne({ mandateId }, { projection: mandateSummaryProjection });
      if (!mandate) throw new ApiError(404, "Mandate not found");
      if (action) {
        const invocation = await invokeCanonicalAction(request, action, mandateId, params.body ?? params.input ?? {}, { idempotencyKey });
        const result = adapterActionResult(action, mandateId, invocation);
        if (invocation.status >= 400 && invocation.status !== 428) {
          return Response.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: invocation.status, message: (invocation.body as Record<string, unknown> | null)?.error ?? "A2A action failed", data: result } }, { status: invocation.status });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { task: taskFromMandate(mandate as Record<string, unknown>), action: result } });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { task: taskFromMandate(mandate as Record<string, unknown>), next: `${env().NEXT_PUBLIC_APP_URL}/api/v1/mandates/${mandateId}/accept` } });
    }
    throw new ApiError(404, `Unsupported A2A method: ${method}`);
  } catch (error) {
    return apiError(error);
  }
}
