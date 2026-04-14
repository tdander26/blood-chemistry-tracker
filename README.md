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

## What it does

- Parses Labcorp PDFs using position-aware text extraction (PDF.js)
- Maps ~70 test names to their spreadsheet row numbers
- Extracts patient name, date, age, and sex
- Sends all values via form POST to the Apps Script (no CORS issues)
- Apps Script copies the template, populates values, exports a PDF, and returns a link

## Files

| File | Purpose |
|------|---------|
| `index.html` | The entire client-side app (single file, no build step) |
| `Code.gs` | Google Apps Script — paste into script.google.com |

## Re-deploying the script

If you ever modify `Code.gs`, you **must** create a **New deployment** (not edit the existing one) for changes to take effect. The URL will change — update it in the app's URL field.
