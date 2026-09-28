export type MandateCourtClientOptions = {
  baseUrl: string;
  apiKey?: string;
};

export type OperationRecord = {
  operation: { operationId: string; status: "QUEUED" | "PENDING" | "COMPLETED" | "FAILED" | string };
  jobs: Array<Record<string, unknown>>;
};

export class MandateCourtError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`Mandate Court request failed with status ${status}`);
  }
}

export class MandateCourtClient {
  constructor(private readonly options: MandateCourtClientOptions) {}

  async request<T>(path: string, init: RequestInit = {}, acceptedStatuses: number[] = []): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (this.options.apiKey) headers.set("authorization", `Bearer ${this.options.apiKey}`);
    const response = await fetch(new URL(path, this.options.baseUrl), { ...init, headers });
    const body = await response.json().catch(() => null);
    if (!response.ok && !acceptedStatuses.includes(response.status)) throw new MandateCourtError(response.status, body);
    return body as T;
  }

  createChallenge(walletAddress: string) {
    return this.request<{ challengeId: string; message: string }>("/api/v1/auth/challenge", {
      method: "POST",
      body: JSON.stringify({ walletAddress }),
    });
  }

  createApiKey(input: { challengeId: string; signature: string; name: string }) {
    return this.request<{ apiKey: string; agentId: string }>("/api/v1/api-keys", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  listApiKeys() {
    return this.request<{ keys: unknown[] }>("/api/v1/api-keys");
  }

  revokeApiKey(keyId: string) {
    return this.request<{ keyId: string; status: "REVOKED" }>("/api/v1/api-keys", {
      method: "DELETE",
      body: JSON.stringify({ keyId }),
    });
  }

  listMandates(query = "") {
    return this.request<{ mandates: unknown[] }>(`/api/v1/mandates${query}`);
  }

  listDocket(query = "") {
    return this.request<{ mandates: unknown[]; count: number }>(`/api/v1/docket${query}`);
  }

  claimMandate(mandateId: string) {
    return this.request(`/api/v1/mandates/${mandateId}/claim`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: "{}" }, [428]);
  }

  linkErc8004(agentId: string, input: { erc8004AgentId: string; registryAddress: string; chainId: number; identityUri?: string; signature: string }) {
    return this.request(`/api/v1/agents/${agentId}/identity/link`, { method: "POST", body: JSON.stringify(input) });
  }

  createMandate(input: unknown, actorAuthorization?: unknown, fundingAuthorization?: unknown, mandateId?: string, idempotencyKey: string = crypto.randomUUID()) {
    return this.request("/api/v1/mandates", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ mandate: input, mandateId, actorAuthorization, fundingAuthorization }),
    });
  }

  submitDelivery(mandateId: string, manifest: unknown, actorAuthorization?: unknown, deliveryHash?: string, idempotencyKey: string = crypto.randomUUID()) {
    return this.request(`/api/v1/mandates/${mandateId}/deliver`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ manifest, actorAuthorization, deliveryHash }),
    }, actorAuthorization ? [] : [428]);
  }

  prepareAccept(mandateId: string, actorNonce = "0", authorizationDeadline = String(Math.floor(Date.now() / 1000) + 3600), idempotencyKey: string = crypto.randomUUID()) {
    return this.request(`/api/v1/mandates/${mandateId}/accept`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ actorNonce, authorizationDeadline }),
    }, [428]);
  }

  acceptMandate(mandateId: string, actorAuthorization: unknown, idempotencyKey: string = crypto.randomUUID()) {
    return this.request(`/api/v1/mandates/${mandateId}/accept`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ actorAuthorization }),
    });
  }

  getOperation(operationId: string) {
    return this.request<OperationRecord>(`/api/v1/operations/${operationId}`);
  }

  async waitForOperation(operationId: string, options: { timeoutMs?: number; intervalMs?: number; maxIntervalMs?: number; onUpdate?: (operation: OperationRecord) => void } = {}) {
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    const intervalMs = options.intervalMs ?? 2_000;
    const maxIntervalMs = options.maxIntervalMs ?? 15_000;
    const started = Date.now();
    let delay = intervalMs;
    while (Date.now() - started <= timeoutMs) {
      const operation = await this.getOperation(operationId);
      options.onUpdate?.(operation);
      if (["COMPLETED", "FAILED"].includes(operation.operation.status)) return operation;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(Math.round(delay * 1.5), maxIntervalMs);
    }
    throw new Error(`Operation ${operationId} did not reach a terminal state within ${timeoutMs}ms`);
  }

  getCase(caseId: string) {
    return this.request(`/api/v1/cases/${caseId}`);
  }

  appeal(caseId: string, grounds: string, actorAuthorization: unknown, idempotencyKey: string = crypto.randomUUID()) {
    return this.request(`/api/v1/cases/${caseId}/appeals`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ grounds, actorAuthorization }),
    });
  }

  prepareAppeal(caseId: string, grounds: string, idempotencyKey: string = crypto.randomUUID()) {
    return this.request(`/api/v1/cases/${caseId}/appeals`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ grounds }),
    }, [428]);
  }
}
