---
submission_id: mandate-court-local-review-2026-08-29
project_name: Mandate Court
review_status: pilot_verification_in_progress
path: intelligent_contract
confidence: medium
---

# Mandate Court — Reviewer Memo

## Snapshot

Mandate Court is a protocol for autonomous agents to form funded service commitments, submit delivery artifacts and evidence, receive an independent GenLayer adjudication, appeal the result, and settle Base escrow according to final judgment. The project combines a real GenLayer adjudicator with Base contracts, an agent API, an SDK/CLI, evidence snapshots, and a live Vercel interface.

## Reviewer Orientation

The implementation is technically substantial and the production API is now accessible. Local contracts, GenLayer direct tests, builds, a real 1Shot transaction, and live health checks are positive evidence. The funded agent-to-agent demonstration and complete final-settlement transcript remain outstanding.

## GenLayer Fit

GenLayer is central rather than decorative: the disputed outcome is whether submitted work satisfies a locked mandate, and the result changes an escrow settlement. The adjudicator evaluates evidence, contradictions, malformed output, prompt injection, and multiple service policies. The main limitation is that Base settlement currently trusts a Vercel-held court attestor to report finalized GenLayer state; this is a meaningful but explicit trust assumption.

## Contract Engineering

The Base contracts have real state transitions, EIP-712 actor/court authorization, per-actor and global court nonces, escrow accounting, replay protection, expiry/refund logic, appeals, and settlement bounds. GenLayer direct tests cover ten service/evidence categories. The strongest remaining engineering concern is cross-system finality: independent cryptographic verification of GenLayer finality is not yet present.

## Engineering Quality

The repository is coherently split into contracts, schemas, SDK, CLI, Next.js API/UI, evidence, relays, and GenLayer tests. The latest Vercel deployment builds successfully and uses live reads rather than fake dashboard state. Pilot confidence is reduced by the incomplete StudioNet matrix, absent funded two-agent transcript, and single-attestor finality bridge.

## Strongest Positives

- GenLayer adjudication materially controls a contested, value-bearing workflow.
- 1Shot exact-execution relay successfully executed a real Base Sepolia transaction.
- Local Base and GenLayer tests cover lifecycle, replay, authorization, adversarial evidence, and malformed judgments.

## Main Concerns

- The historical MongoDB TLS/network failure was resolved on August 30, 2026; current health reports MongoDB `ok`.
- Settlement depends on a centralized court attestor rather than independently proven GenLayer finality.
- GitHub Actions now invokes the processor approximately every five minutes; schedule jitter remains a pilot limitation.

## Human Verification Checklist

- Allow the deployed runtime to reach Atlas and verify health returns 200.
- Exercise create → fund → accept → deliver → adjudicate → appeal/finality → settlement with two disposable wallets.
- Verify the principal’s delivery retrieval endpoint becomes available only after final judgment.
- Inspect the onchain `DisputeRegistry` record and Base settlement event against the API case record.
- Confirm the final lockfile has no unresolved production advisories.

## Evidence Access

`https://mandate-court.vercel.app` — reviewed — deployment is READY and production health reports MongoDB `ok`.
`https://mandate-court.vercel.app/docs` — accessible_limited — documentation route is deployed; authenticated lifecycle cannot be completed while Atlas is unavailable.
`0x3B8C6FA3b6392C580769AEcA3b5E28631DF382a5` — reviewed — deployed StudioNet adjudicator source and direct behavior are available locally; full live matrix pending.
Base Sepolia contracts — reviewed — fresh hardened bytecode and wiring were verified; local Foundry lifecycle is 8/8.


## Verification Update — August 30, 2026

The fresh Base Sepolia deployment and 1Shot ERC-7710 relay probe are successful. The production Agent Card advertises only the implemented REST transport and links to `/docs`; the previously advertised unimplemented A2A endpoint was removed. A small public Agent B delivery repository is available for the pending funded lifecycle. No lifecycle success is claimed until the complete API-to-final-settlement transcript is recorded.

## Verification Update — August 31, 2026

Atlas connectivity is healthy and the historical persistence blocker is resolved. Review-kit findings drove concrete changes: settlement is bound to canonical Base registry/dispute state, commitments are recomputed inside GenLayer, artifacts are fetched alongside evidence, passing findings require retrieved hash-matched sources, API scopes are enforced, native appeal state is tracked, and GitHub Actions replaces the daily Vercel cron. The project remains below production-ready because the live StudioNet matrix currently fails, the funded two-agent transcript is incomplete, and Base still trusts one court signer to attest GenLayer finality.
