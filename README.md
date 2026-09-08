# Blood Chemistry Tracker

Uploads a Labcorp PDF, extracts lab values using PDF.js, and pushes them into a copy of a Google Sheets template via a Google Apps Script web app.

## Setup (one-time)

### 1. Create your Google Sheets template

Create a Google Sheet structured to receive the lab values (or restore a previous one). Copy its ID from the URL:
```
https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID_HERE/edit
```

### 2. Deploy the Apps Script

1. Go to [script.google.com](https://script.google.com) → **New project**
2. Delete any existing code and paste the contents of `Code.gs`
3. **Deploy → New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy** and authorize all permissions (Drive + Sheets + URL Fetch)
5. Copy the `/exec` URL

### 3. Configure the app

Open `index.html` in a browser and fill in:
- **Template Sheet ID** — from step 1
- **Apps Script Web App URL** — from step 2

The "Setup guide" link inside the app walks through this as well.

## Multiple practitioners

The web app is deployed with **Execute as: Me**, so every sheet and PDF it
creates is owned by the deploying account — not by whoever pushed the labs. A
second practitioner using the app would get "You need access" on the result
link and have to file a Drive share request.

To avoid that, the app asks for **Your Google Account** in the sidebar and
sends it with the payload. `Code.gs` grants that address edit access to both
the new sheet and the exported PDF before returning the links, and pins the
links to that account (`authuser=`) so a multi-account browser session opens
them as the right user. The email is remembered in `localStorage`, so it is
typed once per device.

Records still live in the deploying account's Drive, which keeps the clinic's
copy of every report in one place.

> Changing `Code.gs` requires a **New deployment** — see below.

## What it does

- Parses Labcorp PDFs using position-aware text extraction (PDF.js)
- Maps ~70 test names to their spreadsheet row numbers
- Extracts patient name, date, age, and sex
- Sends all values via form POST to the Apps Script (no CORS issues)
- Apps Script copies the template, populates values, exports a PDF, shares both
  with the submitting practitioner, and returns the links

## Files

| File | Purpose |
|------|---------|
| `index.html` | The entire client-side app (single file, no build step) |
| `Code.gs` | Google Apps Script — paste into script.google.com |

## Re-deploying the script

If you ever modify `Code.gs`, you **must** create a **New deployment** (not edit the existing one) for changes to take effect. The URL will change — update it in the app's URL field.
