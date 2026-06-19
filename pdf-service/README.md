# Functional Report PDF Service

A tiny, token-protected HTML→PDF renderer (headless Chrome / Puppeteer) deployed to
**Google Cloud Run in your own project**, so patient data stays inside your Google Cloud
boundary. Google Apps Script sends it the report HTML; it returns a true-vector PDF
(selectable text, exact design fidelity).

---

## One-time setup

### 1. Prerequisites
- A **Google Cloud project** with **billing enabled** (Cloud Run has a generous free tier;
  at clinic volume the running cost is effectively $0).
- **gcloud CLI** installed: https://cloud.google.com/sdk/docs/install
  (Or use **Cloud Shell** in the browser — gcloud is preinstalled there; just upload this
  `pdf-service` folder.)

### 2. Authenticate + pick your project
```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

### 3. Deploy
```bash
cd pdf-service
./deploy.sh
```
On first run this **generates an AUTH_TOKEN and prints it** — copy it. It then builds the
container and deploys to Cloud Run. When it finishes it prints the **Service URL**.

(First deploy takes ~3–5 min while it builds the image. Re-deploys are faster.)

### 4. Connect Apps Script
In your Apps Script project: **Project Settings (gear) → Script Properties → Add property**,
twice:

| Property | Value |
|---|---|
| `PDF_SERVICE_URL` | the Service URL from step 3, with `/render` appended — e.g. `https://functional-report-pdf-xxxx.run.app/render` |
| `PDF_SERVICE_TOKEN` | the AUTH_TOKEN printed in step 3 |

That's it. The next time the web app runs, the Functional Analysis Report renders through
this service.

---

## Test it directly (optional)
```bash
curl -s -X POST "$SERVICE_URL/render" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"html":"<html><body style=\"font-family:sans-serif\"><h1>Hello PDF</h1></body></html>"}' \
  --output test.pdf
open test.pdf
```

---

## Updating the service later
Re-run `AUTH_TOKEN=<your-existing-token> ./deploy.sh` from this folder (pass the existing
token so it doesn't rotate).

---

## Security notes
- The service is deployed `--allow-unauthenticated` (publicly reachable URL) but **rejects any
  request without the correct bearer token**. All traffic is HTTPS.
- For stronger isolation you can later switch to **IAM-authenticated** Cloud Run and have GAS
  send a signed identity token. Ask and I'll wire that up.
- The container holds no patient data at rest — HTML comes in, a PDF goes back, nothing is
  written to disk or logged (only error messages are logged, never the HTML body).

## Cost
Cloud Run bills only while rendering. A report takes ~1–3s of CPU. Free tier covers
~180,000 vCPU-seconds/month — far beyond clinic volume.
