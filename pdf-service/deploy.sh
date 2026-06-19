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
#   ./deploy.sh                 # redeploy, PRESERVING the existing AUTH_TOKEN
#   AUTH_TOKEN=xxxx ./deploy.sh # deploy and set/rotate the shared token
#
set -euo pipefail

REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-functional-report-pdf}"

# OAuth client IDs whose Google logins may call the service (the browser app).
# Defaults to the Blood Chemistry web client; override via env if needed.
AUTH_AUDIENCES="${AUTH_AUDIENCES:-889613087652-fdt1omsivp2l2aqbm2mh4djjq2ekiqeh.apps.googleusercontent.com}"

# Build the env vars to apply. --update-env-vars (merge, not replace) means a
# redeploy PRESERVES the service's existing AUTH_TOKEN unless you pass a new one,
# so the live Apps Script integration keeps working with zero token handling.
ENV_VARS="AUTH_AUDIENCES=$AUTH_AUDIENCES"
if [[ -n "${AUTH_TOKEN:-}" ]]; then
  ENV_VARS="AUTH_TOKEN=$AUTH_TOKEN,$ENV_VARS"
  echo "Will set AUTH_TOKEN (from env) + AUTH_AUDIENCES."
else
  echo "No AUTH_TOKEN passed — preserving the deployed service's existing token; setting AUTH_AUDIENCES."
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
  --update-env-vars "$ENV_VARS"

echo ""
echo "Deployed. Service URL:"
gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)'
echo ""
echo "Next: paste the Service URL + AUTH_TOKEN into your Apps Script Project Settings →"
echo "Script Properties as PDF_SERVICE_URL and PDF_SERVICE_TOKEN."
