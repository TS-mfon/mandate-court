import { apiError, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";

function taskFromMandate(mandate: Record<string, unknown>) {
  return {
    id: String(mandate.mandateId),
    status: { state: String(mandate.status).toLowerCase() },
    metadata: { protocol: "mandate-court/1.1", operationId: mandate.operationId ?? null },
    artifacts: [{ name: "mandate", url: `${env().NEXT_PUBLIC_APP_URL}/api/v1/mandates/${mandate.mandateId}`, mimeType: "application/json" }],
  };
}

export async function GET() {
  return Response.json({
    protocolVersion: "0.3.0",
    name: "Mandate Court A2A Gateway",
    description: "A2A adapter for funded mandates, delivery, adjudication, appeals, and settlement.",
    url: `${env().NEXT_PUBLIC_APP_URL}/api/a2a`,
    capabilities: { streaming: false, pushNotifications: true },
    skills: ["discover-mandates", "accept-mandate", "submit-delivery", "inspect-case", "appeal-judgment"],
    documentationUrl: `${env().NEXT_PUBLIC_APP_URL}/docs#a2a`,
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const method = String(body.method ?? "");
    const params = (body.params ?? {}) as Record<string, unknown>;
    const db = await database();
    if (method === "tasks/get") {
      const mandate = await db.collection("mandates").findOne({ mandateId: String(params.id) }, { projection: { _id: 0 } });
      if (!mandate) throw new ApiError(404, "Task not found");
      return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: taskFromMandate(mandate as Record<string, unknown>) });
    }
    if (method === "tasks/send") {
      const mandateId = String(params.mandateId ?? "");
      if (!mandateId) throw new ApiError(422, "mandateId is required");
      const mandate = await db.collection("mandates").findOne({ mandateId }, { projection: { _id: 0 } });
      if (!mandate) throw new ApiError(404, "Mandate not found");
      return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { task: taskFromMandate(mandate as Record<string, unknown>), next: `${env().NEXT_PUBLIC_APP_URL}/api/v1/mandates/${mandateId}/accept` } });
    }
    throw new ApiError(404, `Unsupported A2A method: ${method}`);
  } catch (error) {
    return apiError(error);
  }
}
