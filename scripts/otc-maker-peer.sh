#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ $# -lt 2 ]]; then
  echo "Usage: scripts/otc-maker-peer.sh <storeName> <scBridgePort> [otc-maker args...]" >&2
  echo "Example: scripts/otc-maker-peer.sh swap-maker 49222 --otc-channel btc-usdt-sol-otc" >&2
  exit 1
fi

STORE_NAME="$1"
SC_PORT="$2"
shift 2

TOKEN_FILE="onchain/sc-bridge/${STORE_NAME}.token"
if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "Missing SC-Bridge token file: $TOKEN_FILE" >&2
  echo "Hint: start the peer once so it generates a token (see scripts/run-swap-*.sh)." >&2
  exit 1
fi

SC_TOKEN="$(tr -d '\r\n' <"$TOKEN_FILE")"

exec node scripts/otc-maker.mjs --url "ws://127.0.0.1:${SC_PORT}" --token "$SC_TOKEN" "$@"

