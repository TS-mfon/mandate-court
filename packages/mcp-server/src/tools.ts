import { MandateCourtClient } from "@mandate-court/sdk";
import type { ServerConfig } from "./config.js";
import { loadSkills } from "./skills.js";
import {
  MANDATE_CONSTRAINTS,
  MANIFEST_CONSTRAINTS,
  mandateTemplate,
  manifestTemplate,
} from "./templates.js";
import {
  createSigner,
  signActorAuthorization,
  signFundingAuthorization,
  WalletRequiredError,
  type PreparedFunding,
  type Signer,
  type TypedData,
} from "./wallet.js";

type Prepared = {
  mandateId?: string;
  deliveryHash?: string;
  actorTypedData?: TypedData;
  fundingAuthorization?: PreparedFunding;
};

/**
 * Holds the client and signer for one MCP process. The client is rebuilt when
 * `authenticate` produces a new API key so later tool calls in the same session use it
 * without the operator restarting the server.
 */
export class CourtSession {
  private activeClient: MandateCourtClient;

  constructor(public readonly config: ServerConfig) {
    this.activeClient = new MandateCourtClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
  }

  get client() {
    return this.activeClient;
  }

  get hasApiKey() {
    return Boolean(this.config.apiKey);
  }

  get hasWallet() {
    return Boolean(this.config.privateKey);
  }

  setApiKey(apiKey: string) {
    this.config.apiKey = apiKey;
    this.activeClient = new MandateCourtClient({ baseUrl: this.config.baseUrl, apiKey });
  }

  signer(): Signer {
    if (this.config.privateKeyError) throw new WalletRequiredError(this.config.privateKeyError);
    if (!this.config.privateKey) throw new WalletRequiredError();
    return createSigner(this.config.privateKey);
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>;
}

function boundedTimeoutMs(args: Record<string, unknown>, fallbackSeconds: number) {
  const raw = Number(args.timeoutSeconds ?? fallbackSeconds);
  const seconds = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 5), 900) : fallbackSeconds;
  return seconds * 1_000;
}

function searchQuery(entries: Array<[string, unknown]>) {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== undefined && item !== null && item !== "") params.append(key, String(item));
      continue;
    }
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * Optionally blocks until a relayed operation reaches a terminal state. A wait timeout
 * is reported alongside the successful submission rather than as a failure, because the
 * operation is still running and still pollable.
 */
async function maybeWait(session: CourtSession, result: unknown, args: Record<string, unknown>) {
  const operationId = (result as { operationId?: unknown } | null)?.operationId;
  if (args.wait !== true || typeof operationId !== "string") return result;
  try {
    const operation = await session.client.waitForOperation(operationId, { timeoutMs: boundedTimeoutMs(args, 300) });
    return { ...(result as object), operation };
  } catch (error) {
    return {
      ...(result as object),
      operationWaitTimedOut: true,
      operationWaitError: error instanceof Error ? error.message : String(error),
      note: `The operation was submitted and was not cancelled. Poll it with wait_for_operation({ operationId: "${operationId}" }).`,
    };
  }
}

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, session: CourtSession): Promise<unknown>;
};

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

const str = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });

const waitProperties = {
  wait: bool("Block until the relayed operation reaches a terminal state. Defaults to false."),
  timeoutSeconds: { type: "integer", description: "Wait ceiling in seconds, 5 to 900. Defaults to 300. A timeout does not cancel the operation.", minimum: 5, maximum: 900 },
  idempotencyKey: str("Reuse the key from a previous attempt to resume that operation instead of starting a second one."),
};

export const tools: ToolDefinition[] = [
  {
    name: "court_doctor",
    description:
      "Check that this MCP server can reach Mandate Court and report which credentials it holds. Reports API and MongoDB readiness, relay and webhook queue depth, Base and GenLayer integration status, and whether an API key and signing wallet are configured. Never returns credential values. Moves no funds. Run this first when anything is failing.",
    inputSchema: object({}),
    async handler(_args, session) {
      let health: unknown;
      let healthError: string | undefined;
      try {
        health = await session.client.request("/api/v1/health");
      } catch (error) {
        healthError = error instanceof Error ? error.message : String(error);
      }
      const skills = loadSkills(session.config.skillsDir);
      return {
        baseUrl: session.config.baseUrl,
        credentials: {
          apiKey: session.hasApiKey ? "configured" : "missing",
          wallet: session.hasWallet ? "configured" : session.config.privateKeyError ? "invalid" : "missing",
          walletAddress: session.hasWallet ? session.signer().address : undefined,
          walletError: session.config.privateKeyError,
        },
        capabilities: {
          reads: true,
          authenticatedReads: session.hasApiKey,
          signedWrites: session.hasApiKey && session.hasWallet,
        },
        skills: { count: skills.skills.length, directory: skills.directory, names: skills.skills.map((skill) => skill.name) },
        health,
        healthError,
      };
    },
  },
  {
    name: "authenticate",
    description:
      "Exchange a wallet signature for a Mandate Court API key. Creates a challenge, signs it locally with AGENT_PRIVATE_KEY, and returns { apiKey, agentId }. The key is shown once, so store it in a secret manager and set MANDATE_COURT_API_KEY. This session starts using the new key immediately. Requires a signing wallet.",
    inputSchema: object({ name: str("Human-readable label for this API key, for example 'Research Agent'.") }),
    async handler(args, session) {
      const signer = session.signer();
      const challenge = await session.client.createChallenge(signer.address);
      const signature = await signer.signMessage(challenge.message);
      const created = await session.client.createApiKey({
        challengeId: challenge.challengeId,
        signature,
        name: optionalString(args, "name") ?? "Mandate Court Agent",
      });
      if (created?.apiKey) session.setApiKey(created.apiKey);
      return { ...created, walletAddress: signer.address, warning: "Store this API key now. Mandate Court will not return it again." };
    },
  },
  {
    name: "register_agent",
    description:
      "Register or update this agent's public profile. walletAddress must match the API key's identity. The skills, supportedPolicies, and deliveryTypes fields are what the open docket filters on, so they decide which funded mandates you are matched against. Set callbackUrl before issuing a webhook secret.",
    inputSchema: object(
      {
        walletAddress: str("The agent wallet, 0x followed by 40 hex characters. Must match the API key identity."),
        name: str("Agent name, 2 to 100 characters."),
        description: str("What this agent does, 10 to 1000 characters."),
        skills: { type: "array", items: { type: "string" }, description: "Skill tags the docket filters on, up to 32." },
        supportedPolicies: { type: "array", items: { type: "string" }, description: "Adjudication policies this agent accepts: GENERAL_V1, RESEARCH_DATA_V1, RESEARCH_DATA_V2, SOFTWARE_WEB_V1, CREATIVE_VISUAL_V1." },
        deliveryTypes: { type: "array", items: { type: "string" }, description: "Delivery types this agent produces, for example dataset or report." },
        callbackUrl: str("HTTPS URL to receive signed lifecycle webhooks."),
        agentCardUrl: str("Optional HTTPS URL of this agent's A2A agent card."),
        a2aUrl: str("Optional HTTPS URL of this agent's A2A endpoint."),
        mcpUrl: str("Optional HTTPS URL of this agent's MCP endpoint."),
      },
      ["walletAddress", "name", "description"],
    ),
    handler(args, session) {
      return session.client.request("/api/v1/agents", { method: "POST", body: JSON.stringify(args) });
    },
  },
  {
    name: "list_agents",
    description: "Discover registered agents, optionally filtered by a single skill tag. Public read.",
    inputSchema: object({ skill: str("Filter to agents advertising this skill tag.") }),
    handler(args, session) {
      return session.client.request(`/api/v1/agents${searchQuery([["skill", optionalString(args, "skill")]])}`);
    },
  },
  {
    name: "get_reputation",
    description: "Read an agent's court-derived reputation. Computed only from finalized judgments, so it reflects adjudicated outcomes rather than self-reported history. Public read.",
    inputSchema: object({ agentId: str("The agent identifier.") }, ["agentId"]),
    handler(args, session) {
      return session.client.request(`/api/v1/reputation/${encodeURIComponent(requireString(args, "agentId"))}`);
    },
  },
  {
    name: "export_reputation",
    description: "Export an agent's finalized feedback records in a portable ERC-8004-compatible form. Public read.",
    inputSchema: object({ agentId: str("The agent identifier.") }, ["agentId"]),
    handler(args, session) {
      return session.client.request(`/api/v1/reputation/${encodeURIComponent(requireString(args, "agentId"))}/export`);
    },
  },
  {
    name: "link_identity",
    description: "Link an optional wallet-signed ERC-8004 identity to this agent, making its court reputation portable to other registries. Requires an API key.",
    inputSchema: object(
      {
        agentId: str("The agent identifier, which must match the API key identity."),
        erc8004AgentId: str("The agent identifier in the ERC-8004 registry."),
        registryAddress: str("The ERC-8004 registry contract address."),
        chainId: { type: "integer", description: "Chain ID the registry is deployed on." },
        identityUri: str("Optional HTTPS URI describing the identity."),
        signature: str("Wallet signature over the link payload."),
      },
      ["agentId", "erc8004AgentId", "registryAddress", "chainId", "signature"],
    ),
    handler(args, session) {
      const agentId = requireString(args, "agentId");
      return session.client.linkErc8004(agentId, {
        erc8004AgentId: requireString(args, "erc8004AgentId"),
        registryAddress: requireString(args, "registryAddress"),
        chainId: Number(args.chainId),
        identityUri: optionalString(args, "identityUri"),
        signature: requireString(args, "signature"),
      });
    },
  },
  {
    name: "list_api_keys",
    description: "List active API key metadata for the authenticated agent. Secret values are never returned. Requires an API key.",
    inputSchema: object({}),
    handler(_args, session) {
      return session.client.listApiKeys();
    },
  },
  {
    name: "revoke_api_key",
    description: "Revoke one of this agent's API keys by ID. Use after rotation or suspected disclosure. Requires an API key.",
    inputSchema: object({ keyId: str("The key ID from list_api_keys.") }, ["keyId"]),
    handler(args, session) {
      return session.client.revokeApiKey(requireString(args, "keyId"));
    },
  },
  {
    name: "list_docket",
    description:
      "Discover unassigned funded mandates a provider can accept. Hard requirements are applied as filters before ranking, so every entry returned is one you can actually perform, and each carries a `match` object naming why it was selected. There is no bidding: the first valid acceptance wins. Results are newest first; pass the returned nextCursor back as cursor to page. Public read.",
    inputSchema: object({
      skill: { type: "array", items: { type: "string" }, description: "Required skill tags. Several values require all of them. A single string is also accepted." },
      policy: str("Filter to one adjudication policy, for example RESEARCH_DATA_V2."),
      deliveryType: str("Filter to mandates accepting this delivery type, for example dataset."),
      chainId: { type: "integer", description: "Filter by payment chain ID. Base Sepolia is 84532." },
      cursor: str("ISO-8601 createdAt taken from a previous response's nextCursor."),
      limit: { type: "integer", description: "1 to 100. Defaults to 50.", minimum: 1, maximum: 100 },
    }),
    handler(args, session) {
      const skill = Array.isArray(args.skill) ? args.skill : optionalString(args, "skill");
      return session.client.listDocket(
        searchQuery([
          ["skill", skill],
          ["policy", optionalString(args, "policy")],
          ["deliveryType", optionalString(args, "deliveryType")],
          ["chainId", args.chainId],
          ["cursor", optionalString(args, "cursor")],
          ["limit", args.limit],
        ]),
      );
    },
  },
  {
    name: "list_mandates",
    description: "List mandates by lifecycle status, policy, or assignee. Use list_docket instead when looking for work to accept. Public read.",
    inputSchema: object({
      status: str("Lifecycle status, for example OPEN, FUNDED, ACCEPTED, DELIVERED, JUDGED, SETTLED."),
      policy: str("Adjudication policy."),
      assignedTo: str("Agent identifier the mandate is assigned to."),
    }),
    handler(args, session) {
      return session.client.listMandates(
        searchQuery([
          ["status", optionalString(args, "status")],
          ["policy", optionalString(args, "policy")],
          ["assignedTo", optionalString(args, "assignedTo")],
        ]),
      );
    },
  },
  {
    name: "inspect_mandate",
    description:
      "Read a mandate in full with its public lifecycle state. Read this before accepting: check payment.amountAtomic (USDC has 6 decimals), deliveryDeadline, every acceptanceCriteria[].expectedEvidence you would have to produce, which criteria are critical, and allowPartialSettlement. Public read.",
    inputSchema: object({ mandateId: str("The mandate identifier, for example MC_....") }, ["mandateId"]),
    handler(args, session) {
      return session.client.request(`/api/v1/mandates/${encodeURIComponent(requireString(args, "mandateId"))}`);
    },
  },
  {
    name: "inspect_case",
    description:
      "Read a case and its finalized judgment. settlementBps is the provider's award out of 10000 and the remainder refunds to the principal. criteria[] gives the per-criterion result, reasonCode, and evidenceRefs; admissibility[] gives evidence the Court refused and why. An accepted judgment is not payable: settlement is authorized only after finality. Public read.",
    inputSchema: object({ caseId: str("The case identifier, which is usually the mandate ID.") }, ["caseId"]),
    handler(args, session) {
      return session.client.getCase(requireString(args, "caseId"));
    },
  },
  {
    name: "get_mandate_template",
    description:
      "Return a valid skeleton mandate plus the constraints the schema enforces. Use this before create_mandate rather than composing a mandate from memory: criterion weightBps must total exactly 10000, deliveryDeadline must follow acceptanceDeadline, and amountAtomic is a decimal string in USDC's 6 decimals. Every criterion must be decidable by a third party holding only the mandate, the manifest, and the linked evidence.",
    inputSchema: object({}),
    async handler() {
      return {
        template: mandateTemplate(),
        constraints: MANDATE_CONSTRAINTS,
        guidance: "Replace objective, deliverables, and every criterion with checkable requirements. Reserve critical: true for genuine go/no-go conditions; marking everything critical removes partial credit.",
      };
    },
  },
  {
    name: "get_manifest_template",
    description:
      "Return a valid skeleton delivery manifest plus the evidence rules that decide the payout. Publish artifacts first, then download the published bytes and hash those, then submit. Pin every URL to an immutable revision such as a full commit SHA. Map every artifact and evidence item to acceptance-criterion IDs: an item mapped to nothing earns nothing, and a criterion nothing maps to fails.",
    inputSchema: object({
      mandateId: str("The mandate being delivered, used to prefill the manifest."),
      providerAgentId: str("This provider's agent identifier."),
    }),
    async handler(args) {
      return {
        template: manifestTemplate(optionalString(args, "mandateId"), optionalString(args, "providerAgentId")),
        constraints: MANIFEST_CONSTRAINTS,
        guidance: "The Court re-downloads every URL, re-hashes the bytes, and compares against your declared sha256 before the case reaches GenLayer. A mismatch, a 404, a redirect to changed content, or a private URL makes that evidence inadmissible, and an appeal reruns on the locked record so it cannot be fixed afterwards.",
      };
    },
  },
  {
    name: "create_mandate",
    description:
      "Create and fund a mandate in one call, as the principal. Performs the whole signed flow: requests preparation, signs the actor EIP-712 payload and the complete EIP-3009 funding authorization locally, and submits. Escrow is locked by transferWithAuthorization, so the wallet needs the USDC balance at signing time and sends no separate approve transaction. Omit providerWallet and providerAgentId in the mandate to publish on the open docket. Requires an API key and a signing wallet. This moves funds.",
    inputSchema: object(
      {
        mandate: { type: "object", description: "The mandate document. Call get_mandate_template first; criterion weightBps must total exactly 10000." },
        ...waitProperties,
      },
      ["mandate"],
    ),
    async handler(args, session) {
      const signer = session.signer();
      const mandate = requireObject(args, "mandate");
      const idempotencyKey = optionalString(args, "idempotencyKey") ?? crypto.randomUUID();
      const prepared = (await session.client.createMandate(mandate, undefined, undefined, undefined, idempotencyKey)) as Prepared;
      if (!prepared?.actorTypedData) throw new Error("The Court did not return actorTypedData for this mandate. Validate the mandate against get_mandate_template.");
      if (!prepared?.fundingAuthorization?.typedData) throw new Error("The Court did not return a funding authorization. Check that the payment block names Base Sepolia USDC.");
      const actorAuthorization = await signActorAuthorization(prepared.actorTypedData, signer);
      const fundingAuthorization = await signFundingAuthorization(prepared.fundingAuthorization, signer);
      const submitted = await session.client.createMandate(mandate, actorAuthorization, fundingAuthorization, prepared.mandateId, idempotencyKey);
      return maybeWait(session, { ...(submitted as object), mandateId: prepared.mandateId, idempotencyKey }, args);
    },
  },
  {
    name: "accept_mandate",
    description:
      "Accept a mandate as the provider, taking on the obligation to deliver before its deliveryDeadline. Performs the signed two-step flow. Acceptance is wallet-bound: only the wallet the mandate authorizes can accept, and only that wallet can then deliver. Read the mandate with inspect_mandate first, because you cannot renegotiate after accepting. Requires an API key and a signing wallet.",
    inputSchema: object({ mandateId: str("The mandate to accept."), ...waitProperties }, ["mandateId"]),
    async handler(args, session) {
      const signer = session.signer();
      const mandateId = requireString(args, "mandateId");
      const idempotencyKey = optionalString(args, "idempotencyKey") ?? crypto.randomUUID();
      const prepared = (await session.client.prepareAccept(mandateId, "0", undefined, idempotencyKey)) as Prepared;
      if (!prepared?.actorTypedData) throw new Error("The Court did not return actorTypedData. The mandate may already be claimed or outside its acceptance window.");
      const actorAuthorization = await signActorAuthorization(prepared.actorTypedData, signer);
      const submitted = await session.client.acceptMandate(mandateId, actorAuthorization, idempotencyKey);
      return maybeWait(session, { ...(submitted as object), mandateId, idempotencyKey }, args);
    },
  },
  {
    name: "prepare_claim",
    description:
      "Prepare a provider claim authorization for a mandate, returning the EIP-712 typed data to sign. Requires an API key. Most providers should use accept_mandate instead, which completes the signed flow in one call.",
    inputSchema: object({ mandateId: str("The mandate to claim.") }, ["mandateId"]),
    handler(args, session) {
      return session.client.claimMandate(requireString(args, "mandateId"));
    },
  },
  {
    name: "submit_delivery",
    description:
      "Submit a delivery manifest as the provider. Performs the signed two-step flow, then the Court snapshots and re-hashes every public URL before the case reaches GenLayer. Publish and hash the published bytes before calling this: an evidence item whose bytes do not match its declared sha256 is inadmissible, and an appeal reruns on the locked record so it cannot be corrected afterwards. Call get_manifest_template first. Requires an API key and a signing wallet.",
    inputSchema: object(
      {
        mandateId: str("The mandate being delivered."),
        manifest: { type: "object", description: "The MDP delivery manifest. Every artifact and evidence item must map to acceptance-criterion IDs." },
        ...waitProperties,
      },
      ["mandateId", "manifest"],
    ),
    async handler(args, session) {
      const signer = session.signer();
      const mandateId = requireString(args, "mandateId");
      const manifest = requireObject(args, "manifest");
      const idempotencyKey = optionalString(args, "idempotencyKey") ?? crypto.randomUUID();
      const prepared = (await session.client.submitDelivery(mandateId, manifest, undefined, undefined, idempotencyKey)) as Prepared;
      if (!prepared?.actorTypedData) throw new Error("The Court did not return actorTypedData. Validate the manifest against get_manifest_template and confirm this wallet accepted the mandate.");
      const actorAuthorization = await signActorAuthorization(prepared.actorTypedData, signer);
      const submitted = await session.client.submitDelivery(mandateId, manifest, actorAuthorization, prepared.deliveryHash, idempotencyKey);
      return maybeWait(session, { ...(submitted as object), mandateId, deliveryHash: prepared.deliveryHash, idempotencyKey }, args);
    },
  },
  {
    name: "appeal_case",
    description:
      "File the one permitted appeal against a judgment. Decided on the locked original record: corrected work and newly created evidence are not admitted, so an appeal is not a second delivery. Cite a specific checkable error against evidence already in the record, naming the criterion ID, the evidence ID, and the mandate text relied on. Read the judgment's appealGrounds first. Requires an API key and a signing wallet.",
    inputSchema: object(
      {
        caseId: str("The case to appeal."),
        grounds: str("The specific factual or contractual error, citing criterion and evidence IDs."),
        ...waitProperties,
      },
      ["caseId", "grounds"],
    ),
    async handler(args, session) {
      const signer = session.signer();
      const caseId = requireString(args, "caseId");
      const grounds = requireString(args, "grounds");
      const idempotencyKey = optionalString(args, "idempotencyKey") ?? crypto.randomUUID();
      const prepared = (await session.client.prepareAppeal(caseId, grounds, idempotencyKey)) as Prepared;
      if (!prepared?.actorTypedData) throw new Error("The Court did not return actorTypedData. The appeal window may be closed or this party's one appeal already used.");
      const actorAuthorization = await signActorAuthorization(prepared.actorTypedData, signer);
      const submitted = await session.client.appeal(caseId, grounds, actorAuthorization, idempotencyKey);
      return maybeWait(session, { ...(submitted as object), caseId, idempotencyKey }, args);
    },
  },
  {
    name: "get_operation",
    description: "Read the current status of one asynchronous operation and its relay jobs, without blocking. Requires an API key.",
    inputSchema: object({ operationId: str("The operation identifier, for example op_....") }, ["operationId"]),
    handler(args, session) {
      return session.client.getOperation(requireString(args, "operationId"));
    },
  },
  {
    name: "wait_for_operation",
    description:
      "Block until an operation reaches COMPLETED or FAILED. Polling backs off from two seconds to a fifteen-second ceiling. A timeout does not cancel the operation, and the same operation ID stays pollable. Requires an API key.",
    inputSchema: object(
      {
        operationId: str("The operation identifier."),
        timeoutSeconds: { type: "integer", description: "Wait ceiling in seconds, 5 to 900. Defaults to 300.", minimum: 5, maximum: 900 },
      },
      ["operationId"],
    ),
    handler(args, session) {
      return session.client.waitForOperation(requireString(args, "operationId"), { timeoutMs: boundedTimeoutMs(args, 300) });
    },
  },
  {
    name: "issue_webhook_secret",
    description:
      "Issue or rotate this agent's webhook signing secret. The plaintext secret is returned exactly once and only an encrypted copy is retained, so store it immediately. Register a callbackUrl with register_agent first or this returns 409. Rotation applies to events enqueued after the call, so keep accepting the previous secret until the in-flight queue drains. Callbacks sign HMAC-SHA256 over '<timestamp>.<raw-body>'; verify in constant time, reject timestamps outside five minutes, and deduplicate on x-mandate-court-event-id. Requires an API key.",
    inputSchema: object({ agentId: str("This agent's identifier, which must match the API key identity.") }, ["agentId"]),
    handler(args, session) {
      const agentId = requireString(args, "agentId");
      return session.client.request(`/api/v1/agents/${encodeURIComponent(agentId)}/webhook-secret`, { method: "POST", body: "{}" });
    },
  },
  {
    name: "list_webhook_deliveries",
    description: "Read this agent's webhook delivery history as metadata only; bodies and signatures are never returned. Statuses are PENDING, DELIVERED, and DEAD_LETTER. Delivery stops after eight attempts. Requires an API key.",
    inputSchema: object({ limit: { type: "integer", description: "1 to 100. Defaults to 50.", minimum: 1, maximum: 100 } }),
    handler(args, session) {
      return session.client.request(`/api/v1/webhooks${searchQuery([["limit", args.limit]])}`);
    },
  },
];

export const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
