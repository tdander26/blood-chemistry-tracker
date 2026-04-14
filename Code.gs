/**
 * Blood Chemistry Tracker — Google Apps Script
 *
 * Deploy as:
 *   Type: Web app
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * After deploying, paste the /exec URL into the app's
 * "Apps Script Web App URL" field.
 *
 * Required OAuth scopes (granted automatically on first deploy):
 *   - https://www.googleapis.com/auth/drive
 *   - https://www.googleapis.com/auth/spreadsheets
 *   - https://www.googleapis.com/auth/script.external_request  (for PDF export)
 */

function doPost(e) {
  try {
    // Accept both form-encoded (name=payload&...) and raw JSON bodies
    var raw;
    if (e.parameter && e.parameter.payload) {
      raw = e.parameter.payload;
    } else if (e.postData && e.postData.contents) {
      raw = e.postData.contents;
    }
    var data = JSON.parse(raw);

    // ── 1. Copy the template sheet ──────────────────────────────────────────
    var templateFile = DriveApp.getFileById(data.templateId);
    var newFile = templateFile.makeCopy(data.newSheetName);
    var newSs = SpreadsheetApp.openById(newFile.getId());
    var sheet = newSs.getSheetByName(data.sheetTabName || 'Blood Chemistry');

    if (!sheet) {
      return HtmlService.createHtmlOutput(
        '<html><body style="font-family:system-ui;text-align:center;padding:60px 20px;">' +
        '<h2 style="color:#991b1b;">Sheet Tab Not Found</h2>' +
        '<p>Could not find a tab named "' + (data.sheetTabName || 'Blood Chemistry') + '" in the template.</p>' +
        '</body></html>'
      );
    }

    // ── 2. Write all lab values ─────────────────────────────────────────────
    var updates = data.updates || [];
    for (var i = 0; i < updates.length; i++) {
      sheet.getRange(updates[i].cell).setValue(updates[i].value);
    }

    // Flush to ensure all writes are committed before PDF export
    SpreadsheetApp.flush();

    // ── 3. Export sheet as PDF and save to Drive ────────────────────────────
    //    Wrapped in try/catch — if PDF fails, the sheet link still works.
    var pdfUrl = '';
    try {
      var ssId = newSs.getId();
      var sheetId = sheet.getSheetId();

      var pdfExportUrl =
        'https://docs.google.com/spreadsheets/d/' + ssId +
        '/export?format=pdf' +
        '&gid='         + sheetId +
        '&size=letter' +
        '&portrait=true' +
        '&fitw=true' +
        '&sheetnames=false' +
        '&printtitle=false' +
        '&pagenumbers=false' +
        '&gridlines=false' +
        '&fzr=false';

      var token    = ScriptApp.getOAuthToken();
      var response = UrlFetchApp.fetch(pdfExportUrl, {
        headers: { 'Authorization': 'Bearer ' + token },
        muteHttpExceptions: true
      });

      if (response.getResponseCode() === 200) {
        var pdfBlob = response.getBlob().setName(data.newSheetName + '.pdf');

        // Save into "Blood Chemistry Reports" folder (created if absent)
        var folders = DriveApp.getFoldersByName('Blood Chemistry Reports');
        var folder  = folders.hasNext()
          ? folders.next()
          : DriveApp.createFolder('Blood Chemistry Reports');

        pdfUrl = folder.createFile(pdfBlob).getUrl();
      }
    } catch (pdfErr) {
      console.error('PDF export failed: ' + pdfErr.message);
    }

    // ── 4. Return success page ──────────────────────────────────────────────
    var pdfLink = pdfUrl
      ? '<p style="margin-top:12px;">' +
          '<a href="' + pdfUrl + '" style="color:#2563eb;font-size:13px;">' +
          'View saved PDF in Drive</a></p>'
      : '';

    return HtmlService.createHtmlOutput(
      '<html><body style="font-family:system-ui;text-align:center;padding:60px 20px;">' +
      '<div style="font-size:48px;margin-bottom:16px;">\u2705</div>' +
      '<h2 style="color:#065f46;">Spreadsheet Created!</h2>' +
      '<p style="color:#333;margin:12px 0;"><strong>' + data.newSheetName + '</strong></p>' +
      '<p style="color:#666;">' + updates.length + ' values populated</p>' +
      '<a href="' + newSs.getUrl() + '" style="display:inline-block;margin-top:20px;padding:12px 32px;' +
        'background:#2563eb;color:white;text-decoration:none;border-radius:8px;font-weight:600;">' +
        'Open Spreadsheet</a>' +
      pdfLink +
      '<p style="margin-top:20px;color:#999;font-size:12px;">You can close this tab when done</p>' +
      '</body></html>'
    );

  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<html><body style="font-family:system-ui;text-align:center;padding:60px 20px;">' +
      '<h2 style="color:#991b1b;">Error</h2>' +
      '<p style="color:#666;">' + err.message + '</p>' +
      '</body></html>'
    );
  }
}

// Health-check endpoint — confirms the script URL is correct
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}
