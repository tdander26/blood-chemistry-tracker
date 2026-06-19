/**
 * apex-trend.js — client-side port of ApexTrend.gs (per-patient longitudinal
 * trend tracker). Maintains a "<NAME> TREND" Google Sheet in the patient folder;
 * each visit adds/overwrites a column. Markers grouped by body system, values
 * color-coded vs functional range, a SPARKLINE per marker, and a "trend vs prior
 * visit" indicator.
 *
 * Differences from the GAS version (only the unavoidable ones): formatting is
 * expressed as Sheets API batchUpdate requests instead of SpreadsheetApp calls;
 * dates use JS Date.
 *
 * Public:  ApexTrend.update({ token, parsed, folder, APEX, collectionDate }) -> url|null
 */
var ApexTrend = (function () {
  'use strict';

  var DATE_COL = 4;          // column D = first visit date (1-based)
  var FIRST_DATA_ROW = 5;    // 1-based row of first marker

  /* ── colors / cells ─────────────────────────────────────────────────── */
  function rgb(hex) {
    var n = parseInt(hex.replace('#', ''), 16);
    return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
  }
  function fmt(o) { return o || {}; }
  function sCell(v, f) { return { userEnteredValue: { stringValue: String(v) }, userEnteredFormat: fmt(f) }; }
  function nCell(v, f) { return { userEnteredValue: { numberValue: v }, userEnteredFormat: fmt(f) }; }
  function fCell(v, f) { return { userEnteredValue: { formulaValue: v }, userEnteredFormat: fmt(f) }; }
  function bCell(f) { return { userEnteredFormat: fmt(f) }; }
  function colLetter(n) { var s = ''; while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; } return s; }

  /* ── dates ──────────────────────────────────────────────────────────── */
  function normalizeDate(value) {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    var s = String(value).trim();
    var m = s.match(/^([0-9]{1,2})[\/\-]([0-9]{1,2})[\/\-]([0-9]{2,4})$/);
    if (m) {
      var mm = m[1].length === 1 ? '0' + m[1] : m[1];
      var dd = m[2].length === 1 ? '0' + m[2] : m[2];
      var yy = m[3]; if (yy.length === 2) yy = (parseInt(yy, 10) > 30 ? '19' : '20') + yy;
      return yy + '-' + mm + '-' + dd;
    }
    if (/^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}/.test(s)) return s.slice(0, 10);
    return new Date().toISOString().slice(0, 10);
  }
  function displayDate(iso) { var p = iso.split('-'); return p.length === 3 ? p[1] + '/' + p[2] + '/' + p[0] : iso; }

  /* ── source markers (this visit) ────────────────────────────────────── */
  function sourceMarkers(parsed, APEX) {
    var out = [], rows = APEX.APEX_SHEET_ROWS, ranges = (APEX.ranges && APEX.ranges.markers) || {}, results = parsed.results;
    Object.keys(rows).forEach(function (name) {
      var res = results[name];
      if (!res || res.value === '' || res.value === null || res.value === undefined) return;
      var rng = ranges[name] || {};
      var value = Number(res.value);
      out.push({ sheet: name, value: isNaN(value) ? res.value : value, fLow: rng.fLow, fHigh: rng.fHigh, units: rng.units });
    });
    return out;
  }

  /* ── parse the existing sheet's values grid (from Sheets values.get) ──── */
  function parseExisting(grid) {
    // grid: 2D array of cell values (row-major), or undefined for an empty sheet.
    if (!grid || grid.length < FIRST_DATA_ROW) return { visits: [], markers: {} };
    var headerRow = grid[3] || [];
    var lastCol = 0;
    grid.forEach(function (r) { if (r && r.length > lastCol) lastCol = r.length; });
    // Visit columns are D.. up to (but excluding) the "Trend" column.
    var trendCol = -1;
    for (var c = lastCol - 1; c >= DATE_COL - 1; c--) {
      if (String(headerRow[c] || '').toLowerCase().indexOf('trend') === 0) { trendCol = c; break; }
    }
    var lastVisitCol = trendCol >= 0 ? trendCol - 1 : lastCol - 1;
    var visits = [];
    for (var c2 = DATE_COL - 1; c2 <= lastVisitCol; c2++) {
      var v = headerRow[c2]; if (!v) continue; visits.push(normalizeDate(v));
    }
    var markers = {};
    for (var r = FIRST_DATA_ROW - 1; r < grid.length; r++) {
      var row = grid[r] || [];
      var name = String(row[0] || '').trim();
      if (!name) continue;
      if (!row[1] && !row[2]) continue;            // section header — skip
      var parts = String(row[1] || '').split('–');
      var fLow = parseFloat(parts[0]), fHigh = parseFloat(parts[1]);
      var values = {};
      for (var i = 0; i < visits.length; i++) {
        var raw = row[DATE_COL - 1 + i];
        if (raw !== '' && raw !== null && raw !== undefined) values[visits[i]] = typeof raw === 'number' ? raw : (isNaN(Number(raw)) ? raw : Number(raw));
      }
      markers[name] = { fLow: isNaN(fLow) ? null : fLow, fHigh: isNaN(fHigh) ? null : fHigh, units: row[2] || null, values: values };
    }
    return { visits: visits, markers: markers };
  }

  function mergeVisit(existing, src, dateIso) {
    var visits = existing.visits.slice();
    if (visits.indexOf(dateIso) === -1) visits.push(dateIso);
    visits.sort();
    var markers = {};
    Object.keys(existing.markers).forEach(function (k) { markers[k] = existing.markers[k]; });
    src.forEach(function (m) {
      var prior = markers[m.sheet] || { fLow: null, fHigh: null, units: null, values: {} };
      markers[m.sheet] = {
        fLow: typeof m.fLow === 'number' ? m.fLow : prior.fLow,
        fHigh: typeof m.fHigh === 'number' ? m.fHigh : prior.fHigh,
        units: m.units || prior.units, values: prior.values,
      };
      markers[m.sheet].values[dateIso] = typeof m.value === 'number' ? m.value : m.raw;
    });
    return { visits: visits, markers: markers };
  }

  function computeIndicator(values, visits, fLow, fHigh) {
    if (visits.length < 1) return { text: '', color: '#666666' };
    var collected = [];
    for (var i = visits.length - 1; i >= 0; i--) {
      var v = values[visits[i]];
      if (typeof v === 'number') { collected.push(v); if (collected.length >= 2) break; }
    }
    if (collected.length === 0) return { text: '', color: '#666666' };
    if (collected.length === 1) return { text: 'first reading', color: '#888888' };
    var current = collected[0], prior = collected[1];
    var inRange = function (v) { return typeof fLow === 'number' && typeof fHigh === 'number' && v >= fLow && v <= fHigh; };
    var devFrom = function (v) { if (typeof fLow !== 'number' || typeof fHigh !== 'number') return 0; if (v < fLow) return fLow - v; if (v > fHigh) return v - fHigh; return 0; };
    if (inRange(current) && inRange(prior)) return { text: '→ stable in range', color: '#16a34a' };
    if (inRange(current) && !inRange(prior)) return { text: '↘ now in range', color: '#16a34a' };
    if (!inRange(current) && inRange(prior)) return { text: '↗ moved out of range', color: '#dc2626' };
    var curDev = devFrom(current), prevDev = devFrom(prior);
    if (curDev < prevDev) return { text: '↘ improving (−' + (prevDev ? Math.round((prevDev - curDev) / prevDev * 100) : 0) + '%)', color: '#16a34a' };
    if (curDev > prevDev) return { text: '↗ worsening (+' + (prevDev ? Math.round((curDev - prevDev) / prevDev * 100) : 0) + '%)', color: '#dc2626' };
    return { text: '→ stable', color: '#6b7280' };
  }

  /* ── build the cell grid + batchUpdate requests ─────────────────────── */
  function buildRequests(sheetId, patientName, dob, merged, APEX) {
    var visits = merged.visits, markers = merged.markers, nV = visits.length;
    var totalCols = DATE_COL - 1 + nV + 2;       // marker,range,units + visits + trend + spark
    var trendCol = DATE_COL + nV;                 // 1-based
    var sparkCol = trendCol + 1;
    var rows = [], merges = [];
    var WHITE = rgb('#ffffff');

    // Row 1: title
    var title = [sCell('PATIENT TREND TRACKER', { textFormat: { bold: true, fontSize: 14, foregroundColor: WHITE }, backgroundColor: rgb('#1f2937'), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' })];
    for (var i = 1; i < totalCols; i++) title.push(bCell({ backgroundColor: rgb('#1f2937') }));
    rows.push({ values: title });
    merges.push(mergeRange(sheetId, 0, 1, 0, totalCols));

    // Row 2: meta
    var meta = patientName + (dob ? '   |   DOB: ' + dob : '') + '   |   ' + nV + ' visit' + (nV === 1 ? '' : 's') +
      '   |   Last updated: ' + new Date().toISOString().slice(0, 10);
    var metaRow = [sCell(meta, { textFormat: { fontSize: 11, foregroundColor: rgb('#374151') }, backgroundColor: rgb('#f9fafb'), horizontalAlignment: 'CENTER' })];
    for (var j = 1; j < totalCols; j++) metaRow.push(bCell({ backgroundColor: rgb('#f9fafb') }));
    rows.push({ values: metaRow });
    merges.push(mergeRange(sheetId, 1, 2, 0, totalCols));

    // Row 3: spacer
    rows.push({ values: [bCell()] });

    // Row 4: header
    var hdr = ['Marker', 'Fnc Range', 'Units'];
    visits.forEach(function (iso) { hdr.push(displayDate(iso)); });
    hdr.push('Trend (vs prior)'); hdr.push('Sparkline');
    rows.push({ values: hdr.map(function (h) { return sCell(h, { textFormat: { bold: true, fontSize: 10, foregroundColor: WHITE }, backgroundColor: rgb('#374151'), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP' }); }) });

    // Body: system groups + markers, then orphans
    var groups = APEX.APEX_SYSTEM_GROUPS.map(function (g) { return { name: g.name, keys: g.markers.filter(function (k) { return markers[k]; }) }; });
    var seen = {}; APEX.APEX_SYSTEM_GROUPS.forEach(function (g) { g.markers.forEach(function (k) { seen[k] = true; }); });
    var orphans = Object.keys(markers).filter(function (k) { return !seen[k]; });
    if (orphans.length) groups.push({ name: 'OTHER', keys: orphans });

    groups.forEach(function (grp) {
      if (!grp.keys.length) return;
      var rowIndex0 = rows.length;                       // 0-based row where this header lands
      var sec = [sCell(grp.name, { textFormat: { bold: true, fontSize: 11, foregroundColor: rgb('#1f2937') }, backgroundColor: rgb('#e5e7eb') })];
      for (var s = 1; s < totalCols; s++) sec.push(bCell({ backgroundColor: rgb('#e5e7eb') }));
      rows.push({ values: sec });
      merges.push(mergeRange(sheetId, rowIndex0, rowIndex0 + 1, 0, totalCols));

      grp.keys.forEach(function (key) {
        var m = markers[key];
        var rowIndex1 = rows.length + 1;                 // 1-based sheet row
        var rangeStr = (typeof m.fLow === 'number' && typeof m.fHigh === 'number') ? (m.fLow + '–' + m.fHigh) : '';
        var trend = computeIndicator(m.values, visits, m.fLow, m.fHigh);
        var cells = [
          sCell(key, { textFormat: { bold: true, foregroundColor: rgb('#111111') } }),
          sCell(rangeStr, { textFormat: { fontSize: 9, foregroundColor: rgb('#6b7280') } }),
          sCell(m.units || '', { textFormat: { fontSize: 9, foregroundColor: rgb('#6b7280') } }),
        ];
        visits.forEach(function (iso, i) {
          var v = m.values[iso];
          var cf = { horizontalAlignment: 'CENTER', textFormat: { fontSize: 10 } };
          if (i === nV - 1) cf.backgroundColor = rgb('#fef9c3');
          if (typeof v === 'number') {
            if (typeof m.fLow === 'number' && v < m.fLow) cf.textFormat = { fontSize: 10, bold: true, foregroundColor: rgb('#1e40af') };
            else if (typeof m.fHigh === 'number' && v > m.fHigh) cf.textFormat = { fontSize: 10, bold: true, foregroundColor: rgb('#991b1b') };
            cells.push(nCell(v, cf));
          } else {
            cells.push(v === undefined ? bCell(cf) : sCell(v, cf));
          }
        });
        cells.push(sCell(trend.text, { textFormat: { italic: true, fontSize: 10, foregroundColor: rgb(trend.color) }, horizontalAlignment: 'LEFT' }));
        // Sparkline over this row's visit cells
        var first = colLetter(DATE_COL) + rowIndex1, last = colLetter(DATE_COL + nV - 1) + rowIndex1;
        var sparkColor = trend.color === '#dc2626' ? '#dc2626' : (trend.color === '#16a34a' ? '#16a34a' : '#2563eb');
        cells.push(fCell('=IFERROR(SPARKLINE(' + first + ':' + last + ', {"charttype","line";"linewidth",2;"color","' + sparkColor + '"}),"")'));
        rows.push({ values: cells });
      });
    });

    var requests = [
      { updateCells: { rows: rows, fields: 'userEnteredValue,userEnteredFormat', start: { sheetId: sheetId, rowIndex: 0, columnIndex: 0 } } },
      { updateSheetProperties: { properties: { sheetId: sheetId, gridProperties: { frozenRowCount: 4, frozenColumnCount: 3 } }, fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount' } },
      dimReq(sheetId, 0, 1, 200), dimReq(sheetId, 1, 2, 80), dimReq(sheetId, 2, 3, 70),
      dimReq(sheetId, DATE_COL - 1, DATE_COL - 1 + nV, 90),
      dimReq(sheetId, trendCol - 1, trendCol, 180), dimReq(sheetId, sparkCol - 1, sparkCol, 110),
    ].concat(merges);
    return requests;
  }
  function mergeRange(sheetId, r0, r1, c0, c1) { return { mergeCells: { range: { sheetId: sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 }, mergeType: 'MERGE_ALL' } }; }
  function dimReq(sheetId, start, end, px) { return { updateDimensionProperties: { range: { sheetId: sheetId, dimension: 'COLUMNS', startIndex: start, endIndex: end }, properties: { pixelSize: px }, fields: 'pixelSize' } }; }

  /* ── I/O orchestration ──────────────────────────────────────────────── */
  function gfetch(url, opts) { return fetch(url, opts).then(async function (r) { if (!r.ok) throw new Error(url.split('?')[0].split('/').pop() + ' ' + r.status + ': ' + (await r.text()).slice(0, 150)); return r; }); }

  async function update(opts) {
    var token = opts.token, parsed = opts.parsed, folder = opts.folder, APEX = opts.APEX;
    var patient = parsed.patient || {};
    var dateIso = normalizeDate(opts.collectionDate || patient.date);
    if (!patient.name) return null;
    var src = sourceMarkers(parsed, APEX);
    if (!src.length) return null;
    var trendName = patient.name + ' TREND';
    var auth = { Authorization: 'Bearer ' + token };

    // 1. Find or create the trend spreadsheet in the patient folder.
    var q = "name='" + trendName.replace(/'/g, "\\'") + "' and '" + folder.id +
      "' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
    var found = await gfetch('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id)', { headers: auth }).then(function (r) { return r.json(); });
    var spreadsheetId;
    if (found.files && found.files.length) {
      spreadsheetId = found.files[0].id;
    } else {
      var created = await gfetch('https://www.googleapis.com/drive/v3/files?fields=id', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
        body: JSON.stringify({ name: trendName, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folder.id] }),
      }).then(function (r) { return r.json(); });
      spreadsheetId = created.id;
    }

    // 2. Read tab + existing values.
    var info = await gfetch('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '?fields=sheets.properties(sheetId,title)', { headers: auth }).then(function (r) { return r.json(); });
    var tab = info.sheets[0].properties;
    var grid = await gfetch('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' + encodeURIComponent("'" + tab.title + "'"), { headers: auth }).then(function (r) { return r.json(); });

    // 3. Merge + rebuild.
    var merged = mergeVisit(parseExisting(grid.values), src, dateIso);
    var requests = buildRequests(tab.sheetId, patient.name, patient.dob || '', merged, APEX);
    await gfetch('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + ':batchUpdate', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
      body: JSON.stringify({ requests: requests }),
    });
    return 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/edit';
  }

  return { update: update, _parseExisting: parseExisting, _mergeVisit: mergeVisit,
           _computeIndicator: computeIndicator, _buildRequests: buildRequests,
           _sourceMarkers: sourceMarkers, _normalizeDate: normalizeDate };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ApexTrend;
