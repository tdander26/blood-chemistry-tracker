#!/usr/bin/env bash
#
# Phase-1 fidelity check for the /export-sheet relay route.
#
# Proves that the client-side rewrite can reproduce the CURRENT app's sheet PDF
# byte-for-byte, by exporting an already-populated sheet through the new route
# and letting you compare it to the PDF the live Apps Script app saved for the
# same sheet.
#
# Usage:
#   SERVICE_URL=https://functional-report-pdf-xxxx.run.app \
#   AUTH_TOKEN=<the service AUTH_TOKEN> \
#   GOOGLE_TOKEN=<an OAuth access token with Drive read on the sheet> \
#   SPREADSHEET_ID=<the populated sheet id> \
#   GID=<the tab's gid, default 0> \
#   ./test-export-sheet.sh
#
# Getting GOOGLE_TOKEN quickly: https://developers.google.com/oauthplayground
#   → authorize scope https://www.googleapis.com/auth/drive.file (or .../drive.readonly)
#   → "Exchange authorization code for tokens" → copy the access token.
#
set -euo pipefail

: "${SERVICE_URL:?Set SERVICE_URL to your Cloud Run service URL}"
: "${AUTH_TOKEN:?Set AUTH_TOKEN to the service token}"
: "${GOOGLE_TOKEN:?Set GOOGLE_TOKEN to a Google OAuth access token}"
: "${SPREADSHEET_ID:?Set SPREADSHEET_ID to the populated sheet id}"
GID="${GID:-0}"
OUT="${OUT:-export-sheet-test.pdf}"

echo "Requesting styled PDF export via /export-sheet …"
http_code=$(curl -sS -o "$OUT" -w '%{http_code}' \
  -X POST "$SERVICE_URL/export-sheet" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"spreadsheetId\":\"$SPREADSHEET_ID\",\"gid\":$GID,\"googleAccessToken\":\"$GOOGLE_TOKEN\",\"filename\":\"export-sheet-test\"}")

if [[ "$http_code" != "200" ]]; then
  echo "FAILED (HTTP $http_code). Response body:"
  cat "$OUT"; echo
  exit 1
fi

bytes=$(wc -c < "$OUT" | tr -d ' ')
echo "OK — saved $OUT ($bytes bytes)."
echo "Compare it against the PDF the current app produced for the same sheet."
echo "If they match visually (and ideally byte-for-byte), fidelity is proven and we proceed to Phase 2."
