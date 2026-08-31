#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing environment file: $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

: "${COURT_SIGNER_PRIVATE_KEY:?COURT_SIGNER_PRIVATE_KEY is required}"
: "${COURT_SIGNER_ADDRESS:?COURT_SIGNER_ADDRESS is required}"
: "${BASE_SEPOLIA_RPC_URL:?BASE_SEPOLIA_RPC_URL is required}"
: "${BASE_USDC_ADDRESS:?BASE_USDC_ADDRESS is required}"

OUT_DIR="$ROOT_DIR/.deployment"
mkdir -p "$OUT_DIR"

deploy() {
  local contract="$1"
  local nonce="$2"
  shift 2
  forge create "$contract" \
    --root "$ROOT_DIR/contracts/base" \
    --rpc-url "$BASE_SEPOLIA_RPC_URL" \
    --private-key "$COURT_SIGNER_PRIVATE_KEY" \
    --nonce "$nonce" \
    --broadcast \
    --json \
    "$@"
}

NEXT_NONCE=$(cast nonce "$COURT_SIGNER_ADDRESS" --block pending --rpc-url "$BASE_SEPOLIA_RPC_URL")

echo "Deploying SettlementAdapter..."
ADAPTER_JSON=$(deploy src/SettlementAdapter.sol:SettlementAdapter "$NEXT_NONCE" --constructor-args "$COURT_SIGNER_ADDRESS")
NEXT_NONCE=$((NEXT_NONCE + 1))
SETTLEMENT_ADAPTER_ADDRESS=$(jq -r '.deployedTo' <<<"$ADAPTER_JSON")

echo "Deploying MandateEscrow..."
ESCROW_JSON=$(deploy src/MandateEscrow.sol:MandateEscrow "$NEXT_NONCE" --constructor-args "$BASE_USDC_ADDRESS" "$SETTLEMENT_ADAPTER_ADDRESS")
NEXT_NONCE=$((NEXT_NONCE + 1))
MANDATE_ESCROW_ADDRESS=$(jq -r '.deployedTo' <<<"$ESCROW_JSON")

echo "Deploying MandateRegistry..."
REGISTRY_JSON=$(deploy src/MandateRegistry.sol:MandateRegistry "$NEXT_NONCE" --constructor-args "$COURT_SIGNER_ADDRESS" "$MANDATE_ESCROW_ADDRESS")
NEXT_NONCE=$((NEXT_NONCE + 1))
MANDATE_REGISTRY_ADDRESS=$(jq -r '.deployedTo' <<<"$REGISTRY_JSON")

echo "Deploying DisputeRegistry..."
DISPUTE_JSON=$(deploy src/DisputeRegistry.sol:DisputeRegistry "$NEXT_NONCE" --constructor-args "$COURT_SIGNER_ADDRESS")
NEXT_NONCE=$((NEXT_NONCE + 1))
DISPUTE_REGISTRY_ADDRESS=$(jq -r '.deployedTo' <<<"$DISPUTE_JSON")

echo "Wiring contracts..."
cast send "$SETTLEMENT_ADAPTER_ADDRESS" "setEscrow(address)" "$MANDATE_ESCROW_ADDRESS" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$COURT_SIGNER_PRIVATE_KEY" --nonce "$NEXT_NONCE" --json > "$OUT_DIR/set-adapter-escrow.json"
NEXT_NONCE=$((NEXT_NONCE + 1))
cast send "$SETTLEMENT_ADAPTER_ADDRESS" "setMandateRegistry(address)" "$MANDATE_REGISTRY_ADDRESS" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$COURT_SIGNER_PRIVATE_KEY" --nonce "$NEXT_NONCE" --json > "$OUT_DIR/set-adapter-registry.json"
NEXT_NONCE=$((NEXT_NONCE + 1))
cast send "$SETTLEMENT_ADAPTER_ADDRESS" "setDisputeRegistry(address)" "$DISPUTE_REGISTRY_ADDRESS" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$COURT_SIGNER_PRIVATE_KEY" --nonce "$NEXT_NONCE" --json > "$OUT_DIR/set-adapter-dispute.json"
NEXT_NONCE=$((NEXT_NONCE + 1))
cast send "$MANDATE_ESCROW_ADDRESS" "setRegistry(address)" "$MANDATE_REGISTRY_ADDRESS" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$COURT_SIGNER_PRIVATE_KEY" --nonce "$NEXT_NONCE" --json > "$OUT_DIR/set-escrow-registry.json"

jq -n \
  --arg chainId "84532" \
  --arg usdc "$BASE_USDC_ADDRESS" \
  --arg courtSigner "$COURT_SIGNER_ADDRESS" \
  --arg settlementAdapter "$SETTLEMENT_ADAPTER_ADDRESS" \
  --arg mandateEscrow "$MANDATE_ESCROW_ADDRESS" \
  --arg mandateRegistry "$MANDATE_REGISTRY_ADDRESS" \
  --arg disputeRegistry "$DISPUTE_REGISTRY_ADDRESS" \
  '{chainId:$chainId,usdc:$usdc,courtSigner:$courtSigner,settlementAdapter:$settlementAdapter,mandateEscrow:$mandateEscrow,mandateRegistry:$mandateRegistry,disputeRegistry:$disputeRegistry}' \
  > "$OUT_DIR/base-sepolia.json"

for pair in \
  "SETTLEMENT_ADAPTER_ADDRESS=$SETTLEMENT_ADAPTER_ADDRESS" \
  "MANDATE_ESCROW_ADDRESS=$MANDATE_ESCROW_ADDRESS" \
  "MANDATE_REGISTRY_ADDRESS=$MANDATE_REGISTRY_ADDRESS" \
  "DISPUTE_REGISTRY_ADDRESS=$DISPUTE_REGISTRY_ADDRESS"; do
  key="${pair%%=*}"
  value="${pair#*=}"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s\n' "$pair" >> "$ENV_FILE"
  fi
done

echo "Base Sepolia deployment written to $OUT_DIR/base-sepolia.json"
jq . "$OUT_DIR/base-sepolia.json"
