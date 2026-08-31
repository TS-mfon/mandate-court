export type MandateCourtClientOptions = {
  baseUrl: string;
  apiKey?: string;
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

  createMandate(input: unknown, actorAuthorization?: unknown, fundingAuthorization?: unknown, mandateId?: string) {
    return this.request("/api/v1/mandates", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ mandate: input, mandateId, actorAuthorization, fundingAuthorization }),
    });
  }

  submitDelivery(mandateId: string, manifest: unknown, actorAuthorization?: unknown, deliveryHash?: string) {
    return this.request(`/api/v1/mandates/${mandateId}/deliver`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ manifest, actorAuthorization, deliveryHash }),
    }, actorAuthorization ? [] : [428]);
  }

  prepareAccept(mandateId: string, actorNonce = "0", authorizationDeadline = String(Math.floor(Date.now() / 1000) + 3600)) {
    return this.request(`/api/v1/mandates/${mandateId}/accept`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ actorNonce, authorizationDeadline }),
    }, [428]);
  }

  acceptMandate(mandateId: string, actorAuthorization: unknown) {
    return this.request(`/api/v1/mandates/${mandateId}/accept`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ actorAuthorization }),
    });
  }

  getCase(caseId: string) {
    return this.request(`/api/v1/cases/${caseId}`);
  }

  appeal(caseId: string, grounds: string, actorAuthorization: unknown) {
    return this.request(`/api/v1/cases/${caseId}/appeals`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ grounds, actorAuthorization }),
    });
  }

  prepareAppeal(caseId: string, grounds: string) {
    return this.request(`/api/v1/cases/${caseId}/appeals`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ grounds }),
    }, [428]);
  }
}
