#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"
ACCOUNT_NAME="mandate-court-studionet"
ACCOUNT_PASSWORD_FILE="$ROOT_DIR/.deployment/genlayer-password"

set -a
source "$ENV_FILE"
set +a

: "${GENLAYER_OPERATOR_PRIVATE_KEY:?GENLAYER_OPERATOR_PRIVATE_KEY is required}"
mkdir -p "$ROOT_DIR/.deployment"
if [[ ! -f "$ACCOUNT_PASSWORD_FILE" ]]; then
  openssl rand -hex 24 > "$ACCOUNT_PASSWORD_FILE"
  chmod 600 "$ACCOUNT_PASSWORD_FILE"
fi
PASSWORD=$(cat "$ACCOUNT_PASSWORD_FILE")

genlayer network set studionet >/dev/null
genlayer account import --name "$ACCOUNT_NAME" --private-key "$GENLAYER_OPERATOR_PRIVATE_KEY" --password "$PASSWORD" --overwrite >/dev/null

OPERATOR=$(cast wallet address --private-key "$GENLAYER_OPERATOR_PRIVATE_KEY")
OUTPUT=$(printf '%s\n' "$PASSWORD" | genlayer deploy --contract "$ROOT_DIR/contracts/genlayer/mandate_adjudicator.py" --args "$OPERATOR")
printf '%s\n' "$OUTPUT" > "$ROOT_DIR/.deployment/genlayer-deploy.log"
TX_HASH=$(printf '%s\n' "$OUTPUT" | grep -Eo '0x[a-fA-F0-9]{64}' | tail -1)

if [[ -z "$TX_HASH" ]]; then
  echo "Unable to extract GenLayer deployment transaction hash" >&2
  exit 1
fi

RECEIPT=$(printf '%s\n' "$PASSWORD" | genlayer receipt "$TX_HASH" --status FINALIZED --retries 180 --interval 3000)
printf '%s\n' "$RECEIPT" > "$ROOT_DIR/.deployment/genlayer-receipt.log"
if ! printf '%s\n' "$RECEIPT" | grep -q "status_name: 'FINALIZED'" || ! printf '%s\n' "$RECEIPT" | grep -q "result: 6"; then
  echo "GenLayer deployment did not finalize successfully; refusing to configure an address" >&2
  exit 1
fi
CONTRACT_ADDRESS=$(printf '%s\n' "$RECEIPT" | sed -n "s/.*contract_address: '\(0x[a-fA-F0-9]\{40\}\)'.*/\1/p" | head -1)

if [[ -z "$CONTRACT_ADDRESS" ]]; then
  echo "Unable to extract deployed GenLayer contract address" >&2
  exit 1
fi

sed -i "s|^GENLAYER_CONTRACT_ADDRESS=.*|GENLAYER_CONTRACT_ADDRESS=$CONTRACT_ADDRESS|" "$ENV_FILE"
jq -n --arg network studionet --arg operator "$OPERATOR" --arg transactionHash "$TX_HASH" --arg contractAddress "$CONTRACT_ADDRESS" \
  '{network:$network,operator:$operator,transactionHash:$transactionHash,contractAddress:$contractAddress}' \
  > "$ROOT_DIR/.deployment/genlayer-studionet.json"
jq . "$ROOT_DIR/.deployment/genlayer-studionet.json"
