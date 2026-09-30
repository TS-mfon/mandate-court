# Mandate Court Security Model

## Assets

- principal USDC in escrow;
- provider entitlement after final judgment;
- immutable mandate and delivery commitments;
- agent identity and nonces;
- GenLayer transaction/finality record;
- court attestor key;
- API keys and webhook secrets.

## Primary Attacks

| Attack | Impact | MVP mitigation |
|---|---|---|
| Fake provider claim | Unjust payout | Claims never count as proof; evidence-linked criterion findings |
| Mutable evidence URL | Post-submission manipulation | Submission snapshot and committed SHA-256 |
| Prompt injection | Manipulated judgment | Constitution marks all external instructions as data; comparative validator principle |
| SSRF | Internal service access | HTTPS, DNS resolution, private-range blocking, timeouts and limits |
| API key theft | Unauthorized API access | HMAC-hashed storage, scopes, rotation; economic actions still require wallet signature |
| Court key theft | False relayed actions | Bounded dual signatures for actor actions; settlement key remains a critical trust point |
| Relay replay | Duplicate calls | Contract actor/court nonces and settlement nonce mapping |
| Premature settlement | Irreversible wrong payout | Finality and execution-result checks before attestation |
| MongoDB compromise | Corrupt UI/index | Canonical funds and contract state remain onchain; signatures rechecked by contracts |
| Evidence deletion | Undetermined result | Snapshot identity and recovery window policy; public mirrors are future work |
| Huge evidence | Cost/DoS | 16-item and 1 MB/item MVP limits |
| Appeal spam | Cost/latency | One application appeal per party and native GenLayer bond rules |
| Webhook forgery | Fabricated lifecycle events | Per-agent secret, timestamped HMAC over the raw body, five-minute replay window |
| Webhook secret disclosure | Event forgery against an agent | Returned once, stored only AES-256-GCM encrypted, rotatable by the owning agent |
| Adapter privilege escalation | Unsigned economic action via A2A/MCP | Adapters route through the canonical REST layer; no adapter path bypasses signatures, nonces, or finality |

## Webhook Secrets

Per-agent webhook secrets are generated server-side, returned exactly once, and retained only as AES-256-GCM ciphertext under `WEBHOOK_ENCRYPTION_KEY`. If that variable is absent the key falls back to `API_KEY_PEPPER`, and `/api/v1/health` reports `webhookEncryption: fallback_api_key_pepper` so the weaker configuration is visible rather than silent. Set `WEBHOOK_ENCRYPTION_KEY` in production.

It is not derived from anything and has no registration step; generate 32 random bytes locally and store them as a deployment secret:

```bash
openssl rand -base64 32
```

Any high-entropy string of at least 24 characters is accepted, but generate it from a CSPRNG rather than choosing it. The value is stretched to an AES-256 key with SHA-256, so its own length is not the constraint; its entropy is. Set it in the Vercel project's environment variables for Production, Preview, and Development separately, and keep it out of the repository, out of `NEXT_PUBLIC_*`, and out of any client bundle.

Treat it as non-rotatable once secrets exist. Every stored ciphertext is encrypted under it, and AES-GCM authenticates on decrypt, so changing the value makes existing webhook secrets fail to decrypt rather than silently produce wrong plaintext. Rotating it therefore requires every agent to call `POST /api/v1/agents/{agentId}/webhook-secret` again. The same applies to a deployment that starts on the `API_KEY_PEPPER` fallback and later sets a distinct `WEBHOOK_ENCRYPTION_KEY`: set it before issuing any agent secrets.

Ciphertext is excluded from both the public and the authenticated agent projections, so a secret is never readable back through the API. Rotation is agent-initiated and applies to events enqueued after the call; receivers should accept the prior secret until the in-flight queue drains.

Callbacks sign `"<timestamp>.<raw-body>"` with HMAC-SHA256 and send it as `x-mandate-court-signature: t=…,v1=…`. Receivers must compare in constant time, reject timestamps outside five minutes, and deduplicate on `x-mandate-court-event-id`, since retries reuse the event ID. Delivery stops after eight attempts and the event is dead-lettered.

## Adapter Authority

The A2A and MCP adapters hold no independent authority. Every lifecycle action they expose is forwarded to the same REST handler an external client would call, carrying the caller's API key and wallet-signed typed data. An adapter cannot mint an action, skip the HTTP 428 preparation step, reuse a nonce, or settle before finality. Caller-supplied idempotency keys are preserved across the adapter boundary so a retried adapter call resumes the original operation rather than creating a second one.

## Critical Trust Point

The court attestor remains trusted to correctly report GenLayer finality to Base. The adapter now requires the attested mandate hash and delivery hash to match `MandateRegistry`, and requires the transaction ID and verdict hash to match a finalized `DisputeRegistry` case. This prevents arbitrary settlement data that disagrees with canonical Base records, but both registries are still written by the court signer. Production deployment therefore still requires threshold attestation or cryptographic GenLayer finality verification.
