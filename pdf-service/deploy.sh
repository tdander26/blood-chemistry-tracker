#!/usr/bin/env bash
#
# One-command deploy of the Functional Report PDF service to Google Cloud Run.
#
# Prerequisites (one-time):
#   1. A Google Cloud project with billing enabled.
#   2. gcloud CLI installed + authenticated:  gcloud auth login
#   3. Set your project:                       gcloud config set project YOUR_PROJECT_ID
#
# Usage:
#   ./deploy.sh                # generates a token on first run, deploys
#   AUTH_TOKEN=xxxx ./deploy.sh # deploy with a specific token
#
set -euo pipefail

REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-functional-report-pdf}"

# Generate a strong token if none provided.
if [[ -z "${AUTH_TOKEN:-}" ]]; then
  AUTH_TOKEN="$(openssl rand -hex 32)"
  echo "================================================================"
  echo "Generated AUTH_TOKEN (SAVE THIS — paste into GAS Script Properties):"
  echo ""
  echo "    $AUTH_TOKEN"
  echo ""
  echo "================================================================"
fi

echo "Enabling required APIs (idempotent)…"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

echo "Deploying $SERVICE to Cloud Run ($REGION)…"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --timeout 120 \
  --concurrency 4 \
  --max-instances 3 \
  --set-env-vars "AUTH_TOKEN=$AUTH_TOKEN"

echo ""
echo "Deployed. Service URL:"
gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)'
echo ""
echo "Next: paste the Service URL + AUTH_TOKEN into your Apps Script Project Settings →"
echo "Script Properties as PDF_SERVICE_URL and PDF_SERVICE_TOKEN."
