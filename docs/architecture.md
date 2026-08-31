# Architecture Decision Record

## ADR-001: Base for economics

Base Sepolia owns USDC custody and deterministic lifecycle enforcement. GenLayer is not used for deposits, deadlines, or arithmetic.

## ADR-002: GenLayer for judgment

Only the evidence-dependent contractual decision uses GenLayer. Prompt Comparative consensus compares structured findings rather than exact prose.

## ADR-003: Relayed dual authorization

The Vercel court signer and 1Shot ERC-7710 relayer execute transactions, while the protocol actor remains the wallet recovered from the actor's EIP-712 signature. Gelato is an optional configured fallback.

## ADR-004: Public evidence in v1

Private evidence would require credentials or a trusted gateway that validators can access consistently. The MVP instead supports public HTTPS evidence with snapshots and hashes.

## ADR-005: MongoDB Atlas

MongoDB stores API identities, documents, queues, and indexed case records. Onchain state remains authoritative for funds and settlement.
