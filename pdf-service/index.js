/**
 * Functional Report PDF Service
 * A small, token-protected HTML→PDF renderer using headless Chrome (Puppeteer).
 * Deploy to Google Cloud Run inside your own project so patient data never
 * leaves your Google Cloud boundary.
 *
 * POST /render
 *   Headers: Authorization: Bearer <AUTH_TOKEN>
 *   Body (JSON): { "html": "<full html string>", "filename": "optional.pdf" }
 *   Returns: application/pdf (vector, selectable text)
 *
 * GET /health → "ok"
 */
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '8mb' }));

const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

// Comma-separated OAuth client IDs whose Google access tokens are accepted (in
// addition to the shared AUTH_TOKEN). This lets the browser app call the service
// with each practitioner's OWN Google login — so no shared secret ships in the
// client. Leave unset to accept any valid Google token (less strict).
const AUTH_AUDIENCES = (process.env.AUTH_AUDIENCES || '')
  .split(',').map(function (s) { return s.trim(); }).filter(Boolean);

function bearerToken(req) {
  return (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

// Authorize a request. Accepts EITHER the shared AUTH_TOKEN (used by the Apps
// Script backend — unchanged, so the live app keeps working) OR a valid Google
// access token (used by the browser app). Google tokens are verified via
// tokeninfo; if AUTH_AUDIENCES is set, the token's audience must match one of
// our OAuth client IDs.
async function authorize(req) {
  const token = bearerToken(req);
  if (!token) return false;
  if (AUTH_TOKEN && token === AUTH_TOKEN) return true;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token));
    if (!r.ok) return false;
    const info = await r.json();
    if (info.expires_in !== undefined && Number(info.expires_in) <= 0) return false;
    if (AUTH_AUDIENCES.length && AUTH_AUDIENCES.indexOf(info.aud) === -1) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// Reuse a single browser instance across requests (faster, lower memory churn).
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--font-render-hinting=none',
      ],
    });
  }
  return browserPromise;
}

app.get('/health', (_req, res) => res.status(200).send('ok'));

app.post('/render', async (req, res) => {
  // ── Auth: shared token (Apps Script) or practitioner Google login (browser app) ──
  if (!(await authorize(req))) {
    return res.status(401).send('Unauthorized');
  }

  const { html, footerLabel } = req.body || {};
  if (!html || typeof html !== 'string') {
    return res.status(400).send('Missing "html" string in body');
  }
  // Sanitize the footer label for safe HTML injection into the footer template.
  const safeLabel = String(footerLabel || '').replace(/[<>&"]/g, '').slice(0, 80);

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Load content; wait for network (Google Fonts) to settle.
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
    // Belt-and-suspenders: wait for webfonts to finish loading before printing.
    try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (e) {}

    const footerTemplate =
      '<div style="width:100%;font-size:7px;font-family:\'IBM Plex Mono\',monospace;' +
      'color:#8C8378;padding:0 0.75in;display:flex;justify-content:space-between;align-items:center;">' +
      '<span>Momentum Health and Wellness · Functional Analysis Report</span>' +
      '<span>Generated for clinical review · Treatment protocols intentionally omitted</span>' +
      '<span>' + safeLabel + ' · Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>' +
      '</div>';

    const pdf = await page.pdf({
      printBackground: true,        // keep color accents
      format: 'Letter',
      margin: { top: '0.5in', bottom: '0.6in', left: '0.75in', right: '0.75in' },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: footerTemplate,
    });

    // Puppeteer v23's page.pdf() returns a Uint8Array; Express's res.send()
    // only treats Buffer/string as binary, so wrap it or it gets JSON-serialized.
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="report.pdf"');
    res.status(200).send(Buffer.from(pdf));
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).send('Render error: ' + err.message);
  } finally {
    if (page) { try { await page.close(); } catch (e) {} }
  }
});

/**
 * POST /export-sheet
 *   Server-side relay for Google Sheets' native PDF export.
 *
 *   Why this exists: a browser can't fetch `docs.google.com/.../export?format=pdf`
 *   directly (that endpoint sends no CORS headers), and the Drive API's own
 *   export drops the fine print controls (scale / margins / gridlines). So when
 *   the app moves client-side, we relay the export here: same URL and the same
 *   params the Apps Script backend used, fetched with the *practitioner's* OAuth
 *   token. The result is a byte-identical styled PDF the client can then upload
 *   into that practitioner's own Drive. PHI stays inside your Cloud Run project.
 *
 *   Headers: Authorization: Bearer <AUTH_TOKEN>   (this service's gate — same as /render)
 *   Body (JSON): {
 *     spreadsheetId:     string,  // the populated sheet (created in the user's Drive)
 *     gid:               number,  // the tab to export
 *     googleAccessToken: string,  // the practitioner's Google OAuth access token
 *     filename?:         string,
 *     params?:           object   // override any export param (defaults reproduce the old GAS export exactly)
 *   }
 *   Returns: application/pdf
 */
app.post('/export-sheet', async (req, res) => {
  // ── Auth: shared token or practitioner Google login ──
  if (!(await authorize(req))) {
    return res.status(401).send('Unauthorized');
  }

  const { spreadsheetId, gid, filename, params } = req.body || {};
  // The export runs as the practitioner: prefer an explicit body token, else the
  // bearer (which, for the browser app, IS the practitioner's Google token).
  const googleAccessToken = (req.body && req.body.googleAccessToken) || bearerToken(req);
  if (!spreadsheetId || !googleAccessToken) {
    return res.status(400).send('Missing "spreadsheetId" or a Google access token');
  }

  // Defaults reproduce the exact layout the Apps Script backend produced
  // (Code.gs), so the output is pixel-identical to the current app. Callers may
  // override any single value via `params`.
  const exportParams = Object.assign({
    format: 'pdf',
    size: 'letter',
    portrait: 'true',
    scale: '2',               // "fit to width"
    top_margin: '0.25',
    bottom_margin: '0.25',
    left_margin: '0.25',
    right_margin: '0.25',
    horizontal_alignment: 'LEFT',
    vertical_alignment: 'TOP',
    sheetnames: 'false',
    printtitle: 'false',
    pagenumbers: 'false',
    gridlines: 'false',
    fzr: 'false',
  }, params || {});
  if (gid !== undefined && gid !== null) exportParams.gid = String(gid);

  const query = new URLSearchParams(exportParams).toString();
  const url = 'https://docs.google.com/spreadsheets/d/' +
    encodeURIComponent(spreadsheetId) + '/export?' + query;

  try {
    const r = await fetch(url, {
      headers: { Authorization: 'Bearer ' + googleAccessToken },
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      // Pass Google's 4xx through faithfully (401/403 = re-auth / permission,
      // 404 = sheet not found or inaccessible) so the client gets a real error;
      // map 5xx / anything unexpected to 502 Bad Gateway.
      const status = (r.status >= 400 && r.status < 500) ? r.status : 502;
      return res.status(status).send('Sheet export failed (' + r.status + '): ' + detail.slice(0, 300));
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const safeName = (String(filename || 'sheet').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 120)) || 'sheet';
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="' + safeName + '.pdf"');
    res.status(200).send(buf);
  } catch (err) {
    console.error('export-sheet error:', err);
    res.status(500).send('Export error: ' + err.message);
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('PDF service listening on ' + port));
