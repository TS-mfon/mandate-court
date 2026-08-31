# Mandate Court — Production Readiness Audit

**Original audit date:** August 29, 2026
**Current verification date:** August 31, 2026
**Scope:** Base contracts, GenLayer adjudicator, Next.js API/UI, SDK/CLI, relay integrations, evidence pipeline, deployment configuration, and the local `GenLayer_Project_Review_Kit`.

## Executive Summary

**Status: TESTNET PILOT IN PROGRESS; NOT MAINNET READY.** MongoDB Atlas is healthy from Vercel, 1Shot successfully submits Base Sepolia transactions, and local Base, API, build, and GenLayer direct checks pass. The historical MongoDB TLS blocker in this report is resolved. Current blockers are redeploying the hardened contracts, passing the live StudioNet matrix, completing the funded two-agent lifecycle, and replacing the single-attestor GenLayer-to-Base trust model before mainnet use.

The most important code-level risks found during review were fixed in this pass:

- Added a Mongo-backed processor lease and limited each processor invocation to one Base relay submission, preventing global `courtNonce` collisions.
- Added a duplicate-key recovery path for concurrent idempotency requests.
- Switched actor authorization preparation to read the live onchain `actorNonces` value.
- Required signed actor authorization for appeals.
- Revalidated every evidence redirect and enforced the evidence byte limit while streaming the response.
- Wired `DisputeRegistry` case linking, appeal recording, and finalization jobs into the processor.
- Added SDK/CLI acceptance preparation and submission helpers.

## Phase 1 — Inventory

### Base contracts

| Contract | Public/external functions | State transitions/events |
|---|---|---|
| `MandateRegistry` | `createMandate`, `acceptMandate`, `submitDelivery`, `cancelMandate`, `markExpired`, `setStatus`, `getMandate` | Funded → Active → Submitted; cancellation/expiry/refund; actor and court nonce validation; emits mandate lifecycle events. |
| `MandateEscrow` | `setRegistry`, `fund`, `bindProvider`, `settle`, `refund` | Holds USDC per mandate; settlement/refund is single-use and non-reentrant; emits funding/provider/settlement/refund events. |
| `SettlementAdapter` | `setEscrow`, `executeFinalJudgment` | Verifies court EIP-712 attestation, deadline, BPS bounds, mandate replay, and judgment nonce before calling escrow. |
| `DisputeRegistry` | `linkCase`, `recordAccepted`, `recordAppeal`, `recordFinalized`, `getCase` | Stores GenLayer transaction, accepted/finalized verdict hashes, one appeal per party, and finality. |
| `SignatureVerifier` | `domainSeparator` | Shared EIP-712 domain and low-s malleability checks. |

### Backend/API routes

- `POST /api/v1/auth/challenge`: creates a wallet challenge.
- `POST /api/v1/api-keys`: verifies the wallet signature and issues an API key.
- `GET/POST /api/v1/agents`: discovers and registers agent identity, wallet, skills, and callback.
- `GET/POST /api/v1/mandates`: lists or prepares/submits funded mandates.
- `GET /api/v1/mandates/{id}`: returns a redacted mandate record.
- `POST /api/v1/mandates/{id}/accept`: returns typed data or queues acceptance.
- `GET/POST /api/v1/mandates/{id}/deliver`: releases delivery only after final judgment, or snapshots and queues delivery.
- `GET /api/v1/cases/{id}`: returns the case record.
- `POST /api/v1/cases/{id}/appeals`: returns typed data or queues a signed appeal.
- `GET /api/v1/reputation/{agentId}`: reads judgment-derived reputation.
- `GET /api/v1/health`: API and MongoDB readiness check.
- `GET /api/internal/process`: CRON-authenticated relay, GenLayer, finality, settlement, and webhook processor.
- `GET /api/fixtures/{fixtureId}`: public deterministic fixtures for StudioNet integration tests.
- `GET /.well-known/agent-card.json`: machine-readable agent discovery metadata.

### External integrations

- Base Sepolia RPC and deployed escrow/registry/adapter/dispute contracts.
- 1Shot relayer JSON-RPC with dynamic exact-execution ERC-7710 delegation and EIP-7702 authorization.
- Optional Gelato gasless fallback; requires `GELATO_RELAY_API_KEY` and funded Gelato Gas Tank.
- GenLayer StudioNet adjudicator and native appeal/finality flow.
- MongoDB Atlas for API keys, agents, mandates, operations, relay jobs, webhook jobs, and processor leases.
- GitHub/public HTTPS evidence is supported as an evidence location, not as an automatic truth source.
- Vercel serverless deployment and a GitHub Actions five-minute processor schedule; manual dispatch remains available for controlled E2E work.

### Client integrations

- The UI reads live API and canonical Base state; no dashboard mock records are used.
- SDK supports challenge login, mandate creation, acceptance preparation/submission, delivery, case reads, and appeals.
- CLI supports `auth login`, mandate list/create/accept/deliver, case inspection, and `doctor`.

## Phase 2 — Verification Matrix

| Area | Result | Evidence |
|---|---|---|
| Base contract lifecycle | PASS | `contracts/base/test/MandateCourt.t.sol`: 8/8 tests, including finalized-state and commitment mismatch rejection. |
| Wrong provider rejection | PASS | Foundry test `testDirectAssignmentRejectsWrongProvider`. |
| Settlement replay protection | PASS | Foundry test `testDuplicateSettlementReverts`. |
| Per-party appeal limit | PASS | Foundry test `testEachPartyGetsOneAppeal`. |
| Expired unaccepted refund | PASS | Foundry test `testExpiredUnacceptedMandateRefundsPrincipal`. |
| Schema validation | PASS | `tests/protocol.test.ts`: 5/5 tests. |
| GenLayer lint and direct behavior | PASS | 13/13 direct tests, including injection, conflicts, malformed output, and mutated hashes. |
| Production build | PASS | `pnpm build`; Vercel build completed and deployment is READY. |
| 1Shot transaction execution | PASS | Real probe succeeded on August 29, 2026; Base transaction recorded in `.deployment/oneshot-probe.json`. |
| Gelato fallback | NOT VERIFIED | No usable Gelato API key/Gas Tank was available. The SDK is present, but the fallback cannot submit without provider credentials. |
| MongoDB Atlas | FAIL/BLOCKED | Vercel health reports HTTP 503 and `tls_handshake`; direct connection cannot reach the Atlas hostname. |
| Full StudioNet matrix | NOT RERUN | Direct tests pass; the live matrix remains pending external network/database availability. |
| Two-agent funded E2E | NOT RUN | Correctly blocked by MongoDB persistence and no permission to fabricate wallets/funds/repositories. |

## Phase 3 — Findings

### High — MongoDB Atlas prevents all persistent production workflows

This was the August 29, 2026 condition. As of August 31, 2026, the production health endpoint reports MongoDB `ok` and API-key authentication, mandate storage, relay jobs, webhook jobs, and processor leases are available. Rotate the database password because it was shared in chat.

### High — Settlement attestation remains a trusted Vercel-held key

`SettlementAdapter` verifies the court attestor’s EIP-712 signature but cannot independently verify the GenLayer finalized state. The current design is an explicit oracle/attestor trust model. Do not market this as trustless settlement until a cryptographic GenLayer finality proof, threshold attestation, or equivalent bridge is implemented.

### Medium — Vercel Hobby cron is too infrequent for an asynchronous court

The former daily Vercel cron was unsuitable for relay polling, appeal windows, and timely settlement. `.github/workflows/process-court.yml` now invokes the processor approximately every five minutes with manual dispatch and concurrency protection. GitHub schedule jitter remains a pilot limitation.

### Medium — Gelato is not credential-free

The deprecated `gelatodigital/relay-sdk` cannot remove the need for Gelato authorization. The maintained `@gelatocloud/gasless` client still requires an API key and funded Gas Tank. 1Shot is currently the working provider; Gelato should remain an explicit, configured fallback rather than an assumed one.

### Low — Dependency audit finding

The production dependency graph previously reported a moderate `uuid` advisory below `11.1.1`. A pnpm workspace override is now configured in `pnpm-workspace.yaml`; rerun `pnpm install` and `pnpm audit --prod` with registry connectivity and verify the lockfile resolves the patched version.

## Security Controls Verified

- EIP-712 actor and court authorization binds mandate, action, payload, actor, actor nonce, court nonce, and deadline.
- Base contracts reject expired signatures, wrong parties, invalid status, invalid BPS, zero addresses, replayed judgments, and duplicate appeals.
- Escrow uses a non-reentrancy guard and marks settlement before external token transfers.
- API keys are stored as hashes and wallet identity is checked against the authenticated API key.
- Idempotency keys are required for authenticated state-changing operations.
- Evidence requires HTTPS, rejects private IP targets, caps response size, times out requests, and revalidates redirect destinations.
- Evidence content is hashed at snapshot time; a URL alone is not treated as proof.
- Submitted evidence is treated as untrusted data by the GenLayer adjudicator, including prompt-injection content.

## Required Release Gate

1. Fix Atlas Network Access/DNS and rotate the exposed database credential.
2. Confirm `/api/v1/health` returns HTTP 200 with `mongodb: ok`.
3. Rerun the StudioNet matrix against the deployed fixture endpoint.
4. Configure a scheduler that runs the processor at least every 15–60 seconds.
5. Decide whether the Vercel court attestor trust model is acceptable for the testnet release.
6. Run the two disposable-agent lifecycle with a small test amount, verify final Base settlement, and verify the principal can retrieve the released delivery.
7. Re-run `pnpm audit --prod` and inspect the final lockfile before public production use.


## Verification Update — August 30, 2026

- Fresh Base Sepolia deployment is live and wired: `SettlementAdapter`, `MandateEscrow`, `MandateRegistry`, and `DisputeRegistry` all have bytecode; adapter/escrow/registry/token/signer relationships were read back successfully.
- 1Shot ERC-7710 probe succeeded against the fresh `DisputeRegistry`; Gelato fallback remains intentionally disabled because no Gelato API key or funded Gas Tank is configured. The 1Shot SDK/relay path does not require Gelato credentials when it succeeds.
- Vercel production deployment `dpl_71Mx3ZbUWM1c22PMGzGbpEr3pfGf` is `READY`; `/docs` returns HTTP 200 and the Agent Card advertises only the implemented HTTP+JSON REST API plus its documentation URL.
- The two disposable Base Sepolia wallets are funded for the authorized test: Agent A has exactly `2 USDC` and `0.001 ETH`; Agent B has `0.001 ETH`.
- Public delivery evidence repository: `TS-mfon/mandate-court-agent-b-delivery-20260830`.
- Resolved blocker: production health now reports MongoDB `ok`; the two-agent lifecycle can be persisted. Credential rotation remains required before production funds.
- Local verification remains green: Foundry `5/5`, Vitest `6/6`, GenLayer lint/direct `13/13`, production dependency audit reports no known vulnerabilities, and contract coverage under IR mode is `80.89%` lines / `86.11%` functions.
- Latest production deployment after lifecycle hardening: `dpl_9Q116iSz6Dx36hKFs4pjqrVtwfx5` (`READY`).

## Verification Update — August 31, 2026

- Production health returns HTTP 200 with both API and MongoDB healthy; the August 29 TLS blocker is historical.
- `SettlementAdapter` now requires canonical `MandateRegistry` commitments and matching finalized `DisputeRegistry` transaction/verdict state.
- Foundry passes `8/8`; Vitest passes `6/6`; GenLayer lint/direct passes `13/13`.
- API-key scopes are enforced, new keys receive read/write/appeal scopes, and owned keys can be revoked.
- The processor records accepted verdicts, defers finalization while an appeal submission is pending, tracks native same-transaction appeals, and only schedules settlement after Base records finalization.
- GenLayer recomputes mandate/delivery commitments, fetches artifacts and evidence, and rejects `PASS` findings supported by inaccessible or hash-mismatched sources.
- The daily Vercel cron was removed in favor of `.github/workflows/process-court.yml` at an approximate five-minute cadence.
- The live StudioNet matrix was rerun and failed at the second primary case. This remains a release blocker.
- The single court-attestor trust model remains a mainnet blocker even though Base rejects settlement data inconsistent with its canonical registries.
