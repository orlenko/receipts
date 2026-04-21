#!/usr/bin/env bash
# Query Cloudflare Analytics Engine for recent traffic stats.
#
# Requires env vars (never committed):
#   CF_ACCOUNT_ID       — your Cloudflare account ID
#   CF_API_TOKEN        — a token with "Account Analytics: Read" permission
#   RECEIPTS_DATASET    — AE dataset name bound to HITS (default: receipts_hits)
#   RECEIPTS_DOMAIN     — hostname to filter on (default: receipts.clickable.one)
#
# Put them in ~/.receipts.env (gitignored at your home) and `source` it:
#   source ~/.receipts.env && ./scripts/stats.sh

set -euo pipefail

: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID not set}"
: "${CF_API_TOKEN:?CF_API_TOKEN not set}"
: "${RECEIPTS_DATASET:=receipts_hits}"
: "${RECEIPTS_DOMAIN:=receipts.clickable.one}"

days="${1:-7}"

sql=$(cat <<EOF
SELECT count() AS hits, blob2 AS country
FROM $RECEIPTS_DATASET
WHERE index1 = '$RECEIPTS_DOMAIN'
  AND timestamp > NOW() - INTERVAL '$days' DAY
GROUP BY country
ORDER BY hits DESC
FORMAT JSON
EOF
)

echo "→ last ${days} day(s) of hits at ${RECEIPTS_DOMAIN}:"
echo

curl -fsS "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  --data "$sql" \
  | jq -r '.data[] | "\(.country // "??")\t\(.hits)"' \
  | awk -F'\t' 'BEGIN { printf "%-10s %s\n", "country", "hits" } { printf "%-10s %s\n", $1, $2 }'
