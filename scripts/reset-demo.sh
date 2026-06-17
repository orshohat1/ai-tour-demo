#!/usr/bin/env bash
# Reset the demo to a clean, deterministic state between recording takes.
#
# Resets the seeded Contoso Markets backend so the duplicate-charge case and all
# balances are identical on every take. Point it at the local API (default) or a
# deployed API via API_BASE.
#
# Usage:
#   scripts/reset-demo.sh                       # resets http://localhost:3000
#   API_BASE=https://my-api scripts/reset-demo.sh
#   ADMIN_TOKEN=secret scripts/reset-demo.sh    # if ADMIN_RESET_TOKEN is set on the API

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
TOKEN_HEADER=()
if [ -n "${ADMIN_TOKEN:-}" ]; then
  TOKEN_HEADER=(-H "x-admin-token: ${ADMIN_TOKEN}")
fi

echo "Resetting demo backend at ${API_BASE} ..."
http_code=$(curl -s -o /tmp/reset-demo.out -w "%{http_code}" -X POST "${API_BASE}/admin/reset" \
  -H "Content-Type: application/json" "${TOKEN_HEADER[@]}" || true)

if [ "$http_code" = "200" ]; then
  echo "✓ Reset OK: $(cat /tmp/reset-demo.out)"
else
  echo "✗ Reset failed (HTTP ${http_code}): $(cat /tmp/reset-demo.out 2>/dev/null || true)" >&2
  echo "  Is the API running? Try: cd src/api && pnpm dev" >&2
  exit 1
fi
