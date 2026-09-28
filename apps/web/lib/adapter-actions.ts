import { randomUUID } from "node:crypto";
import { POST as createMandate } from "@/app/api/v1/mandates/route";
import { POST as claimMandate } from "@/app/api/v1/mandates/[mandateId]/claim/route";
import { POST as acceptMandate } from "@/app/api/v1/mandates/[mandateId]/accept/route";
import { POST as deliverMandate } from "@/app/api/v1/mandates/[mandateId]/deliver/route";
import { POST as appealCase } from "@/app/api/v1/cases/[caseId]/appeals/route";
import { GET as getOperation } from "@/app/api/v1/operations/[operationId]/route";

export type AdapterAction = "create" | "claim" | "accept" | "deliver" | "appeal";

type AdapterInvocation = {
  status: number;
  body: unknown;
  headers: Headers;
};

async function readResponse(response: Response): Promise<AdapterInvocation> {
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
}

export async function invokeCanonicalAction(
  request: Request,
  action: AdapterAction,
  identifier: string | undefined,
  body: unknown,
  options: { idempotencyKey?: string } = {},
): Promise<AdapterInvocation> {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!['content-length', 'host'].includes(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("content-type", "application/json");
  headers.set("idempotency-key", options.idempotencyKey ?? headers.get("idempotency-key") ?? randomUUID());
  const forwarded = new Request(request.url, { method: "POST", headers, body: JSON.stringify(body ?? {}) });

  if (action === "create") return readResponse(await createMandate(forwarded));
  if (!identifier) throw new Error(`${action} requires an identifier`);
  if (action === "claim") return readResponse(await claimMandate(forwarded, { params: Promise.resolve({ mandateId: identifier }) }));
  if (action === "accept") return readResponse(await acceptMandate(forwarded, { params: Promise.resolve({ mandateId: identifier }) }));
  if (action === "deliver") return readResponse(await deliverMandate(forwarded, { params: Promise.resolve({ mandateId: identifier }) }));
  return readResponse(await appealCase(forwarded, { params: Promise.resolve({ caseId: identifier }) }));
}

export async function invokeCanonicalOperation(request: Request, operationId: string): Promise<AdapterInvocation> {
  return readResponse(await getOperation(request, { params: Promise.resolve({ operationId }) }));
}

export function adapterActionResult(action: AdapterAction, identifier: string | undefined, response: AdapterInvocation) {
  const body = response.body as Record<string, unknown> | null;
  return {
    action,
    identifier: identifier ?? null,
    status: response.status,
    accepted: response.status >= 200 && response.status < 300,
    preparationRequired: response.status === 428,
    body,
  };
}
