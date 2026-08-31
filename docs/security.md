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

## Critical Trust Point

The court attestor remains trusted to correctly report GenLayer finality to Base. The adapter now requires the attested mandate hash and delivery hash to match `MandateRegistry`, and requires the transaction ID and verdict hash to match a finalized `DisputeRegistry` case. This prevents arbitrary settlement data that disagrees with canonical Base records, but both registries are still written by the court signer. Production deployment therefore still requires threshold attestation or cryptographic GenLayer finality verification.
