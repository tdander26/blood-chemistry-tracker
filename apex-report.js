/**
 * apex-report.js — client-side port of ApexReport.gs (Functional Analysis report).
 *
 * Builds the "Range Strips" report HTML from extracted marker values + the static
 * ranges (ranges.json) + config (apex-data.json / apex-markers.json). The HTML is
 * then sent to the pdf-service /render route (vector PDF), exactly as the Apps
 * Script version did — so output is identical.
 *
 * Differences from ApexReport.gs (only the unavoidable ones):
 *   - markers are built from parsed values + ranges.json (not a live sheet),
 *   - date formatting uses JS Date (not Utilities.formatDate),
 *   - handout-page embedding is stubbed until the images are bundled as assets.
 *
 * Public API:  ApexReport.build(patient, parsedResults, ranges, APEX) -> html string
 *   patient        { name, age, sex, date }
 *   parsedResults  parsePdf().results — { markerName: { value, row, ... } }
 *   ranges         ranges.json — { layout, markers: { name: {fLow,fHigh,labLow,labHigh,units} } }
 *   APEX           { markers(apex-markers.json), APEX_SHEET_ROWS, APEX_SHEET_TO_MANUAL,
 *                    APEX_THYROID_CATEGORIES, APEX_COMPUTED_PATTERNS,
 *                    APEX_THYROID_SHEET_MARKERS, APEX_SYSTEM_GROUPS,
 *                    APEX_NL_RATIO_LOW, APEX_NL_RATIO_HIGH, APEX_HANDOUTS }
 */
var ApexReport = (function () {
  'use strict';

  // Config, set per-build from the loaded assets.
  var MARKERS, SHEET_ROWS, SHEET_TO_MANUAL, THY_CATS, CMP_PATS,
      THY_SHEET_MARKERS, SYSTEM_GROUPS, NL_LOW, NL_HIGH;
  function setConfig(A) {
    MARKERS           = A.markers;
    SHEET_ROWS        = A.APEX_SHEET_ROWS;
    SHEET_TO_MANUAL   = A.APEX_SHEET_TO_MANUAL;
    THY_CATS          = A.APEX_THYROID_CATEGORIES;
    CMP_PATS          = A.APEX_COMPUTED_PATTERNS;
    THY_SHEET_MARKERS = A.APEX_THYROID_SHEET_MARKERS;
    SYSTEM_GROUPS     = A.APEX_SYSTEM_GROUPS;
    NL_LOW            = A.APEX_NL_RATIO_LOW;
    NL_HIGH           = A.APEX_NL_RATIO_HIGH;
    sysCache = null;
  }

  // ───────────── 1. markers (port of _apexReadMarkers, sheet → ranges.json) ──
  function buildMarkers(parsedResults, ranges) {
    var markers = [];
    Object.keys(SHEET_ROWS).forEach(function (name) {
      var res = parsedResults[name];
      if (!res || res.value === '' || res.value === null || res.value === undefined) return;
      var rng = (ranges.markers && ranges.markers[name]) || {};
      var value = Number(res.value);
      var hasNumeric = !isNaN(value);
      function dir(v, lo, hi) {
        if (!hasNumeric || typeof lo !== 'number' || typeof hi !== 'number') return null;
        if (v < lo) return 'low';
        if (v > hi) return 'high';
        return 'normal';
      }
      var fDirection = dir(value, rng.fLow, rng.fHigh);
      var labDirection = dir(value, rng.labLow, rng.labHigh);
      markers.push({
        sheet: name, manual: SHEET_TO_MANUAL[name] || null, row: SHEET_ROWS[name],
        raw: res.value, value: hasNumeric ? value : res.value,
        fLow: rng.fLow, fHigh: rng.fHigh, labLow: rng.labLow, labHigh: rng.labHigh,
        units: rng.units, fDirection: fDirection, labDirection: labDirection,
        direction: fDirection,
      });
    });
    return markers;
  }

  function findMarker(markers, sheetName) {
    for (var i = 0; i < markers.length; i++) if (markers[i].sheet === sheetName) return markers[i];
    return null;
  }

  // ───────────── 2. trigger evaluation (verbatim logic) ──────────────────────
  function conditionMatches(condition, markers) {
    if (condition.rule === 'nlRatioNear1to1') {
      var n = findMarker(markers, 'Neutrophils'), l = findMarker(markers, 'Lymphs');
      if (!n || !l || typeof n.value !== 'number' || typeof l.value !== 'number' || l.value === 0) return false;
      var ratio = n.value / l.value;
      return ratio >= NL_LOW && ratio <= NL_HIGH;
    }
    if (condition.rule === 'astAltRatioLessThan1' || condition.rule === 'astAltRatioGreaterThanOrEqual2') {
      var ast = findMarker(markers, 'AST (SGOT)'), alt = findMarker(markers, 'ALT (SGPT)');
      if (!ast || !alt || typeof ast.value !== 'number' || typeof alt.value !== 'number' || alt.value === 0) return false;
      var astAlt = ast.value / alt.value;
      return condition.rule === 'astAltRatioLessThan1' ? astAlt < 1.0 : astAlt >= 2.0;
    }
    var m = findMarker(markers, condition.sheet), dir = condition.dir;
    if (dir === 'notHigh') return !m || !m.direction || m.direction !== 'high';
    if (dir === 'notLow')  return !m || !m.direction || m.direction !== 'low';
    if (!m || !m.direction) return false;
    if (dir === 'low')          return m.direction === 'low';
    if (dir === 'high')         return m.direction === 'high';
    if (dir === 'normal')       return m.direction === 'normal';
    if (dir === 'normalOrLow')  return m.direction === 'normal' || m.direction === 'low';
    if (dir === 'normalOrHigh') return m.direction === 'normal' || m.direction === 'high';
    return false;
  }
  function triggerFires(trigger, markers) {
    for (var i = 0; i < trigger.length; i++) if (!conditionMatches(trigger[i], markers)) return false;
    return true;
  }
  function detectPatterns(categories, markers) {
    var hits = [];
    categories.forEach(function (cat) {
      var supporting = [], fired = false;
      cat.triggers.forEach(function (trigger) {
        if (triggerFires(trigger, markers)) {
          fired = true;
          trigger.forEach(function (cond) {
            if (cond.sheet) {
              if (cond.dir === 'notHigh' || cond.dir === 'notLow') return;
              var m = findMarker(markers, cond.sheet);
              if (m && m.direction) supporting.push(m);
            } else if (cond.rule === 'nlRatioNear1to1') {
              var n = findMarker(markers, 'Neutrophils'), l = findMarker(markers, 'Lymphs');
              if (n) supporting.push(n); if (l) supporting.push(l);
            } else if (cond.rule === 'astAltRatioLessThan1' || cond.rule === 'astAltRatioGreaterThanOrEqual2') {
              var ast2 = findMarker(markers, 'AST (SGOT)'), alt2 = findMarker(markers, 'ALT (SGPT)');
              if (ast2) supporting.push(ast2); if (alt2) supporting.push(alt2);
            }
          });
        }
      });
      if (fired) {
        if (cat.aux) cat.aux.forEach(function (auxCond) {
          var m = findMarker(markers, auxCond.sheet);
          if (m && m.direction === auxCond.dir) supporting.push(m);
        });
        hits.push({ category: cat, supporting: unique(supporting) });
      }
    });
    return hits;
  }
  function unique(arr) {
    var seen = {}, out = [];
    arr.forEach(function (m) { if (m && !seen[m.sheet]) { seen[m.sheet] = true; out.push(m); } });
    return out;
  }

  // ───────────── 3. cross-marker cause aggregation ───────────────────────────
  function aggregateCauses(markers) {
    var causeMap = {};
    markers.forEach(function (m) {
      if (!m.fDirection || m.fDirection === 'normal') return;
      if (THY_SHEET_MARKERS.indexOf(m.sheet) !== -1) return;
      if (!m.manual) return;
      var entry = MARKERS[m.manual];
      if (!entry) return;
      var section = m.fDirection === 'high' ? entry.elevated : entry.depressed;
      if (!section || !section.causes) return;
      section.causes.forEach(function (cause) {
        (causeMap[cause] = causeMap[cause] || []).push(m.sheet);
      });
    });
    return Object.keys(causeMap).map(function (cause) {
      return { cause: cause, supporting: causeMap[cause] };
    }).sort(function (a, b) { return b.supporting.length - a.supporting.length; })
      .filter(function (c) { return c.supporting.length >= 2; });
  }

  // ───────────── 4. HTML helpers (verbatim) ──────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function num(x) {
    if (typeof x !== 'number' || isNaN(x)) return esc(x);
    return String(Math.round(x * 100) / 100);
  }
  var DISPLAY_NAMES = {
    'LDL Chol Calc (NIH)': 'LDL', 'HDL Cholesterol': 'HDL', 'Cholesterol, Total': 'Total Cholesterol',
    'VLDL Cholesterol Cal': 'VLDL', 'C-Reactive Protein, Cardiac': 'hs-CRP',
    'Iron Bind.Cap.(TIBC)': 'TIBC', 'Vitamin D, 25-Hydroxy': 'Vitamin D, 25-OH',
    'Hemoglobin A1c': 'HbA1c', 'Protein, Total': 'Total Protein', 'Globulin, Total': 'Globulin',
    'Bilirubin, Total': 'Total Bilirubin', 'Bilirubin, Direct': 'Bilirubin (Direct)',
    'Bilirubin, Indirect': 'Bilirubin (Indirect)', 'Carbon Dioxide, Total': 'CO₂',
    'Homocyst(e)ine': 'Homocysteine', 'Lymphs': 'Lymphocytes', 'Insulin': 'Fasting Insulin',
    'AST (SGOT)': 'AST (SGOT)', 'ALT (SGPT)': 'ALT (SGPT)', 'Alkaline Phosphatase': 'Alk. Phosphatase',
    'TSH': 'TSH', 'Thyroxine (T4)': 'T4', 'Triiodothyronine (T3)': 'T3',
    'Triiodothyronine (T3), Free': 'Free T3', 'T4,Free(Direct)': 'Free T4',
    'Reverse T3, Serum': 'Reverse T3', 'Thyroid Peroxidase (TPO) Ab': 'TPO Ab',
    'Thyroglobulin Antibody': 'Tgb Ab', 'Thyroxine Binding Globulin': 'TBG',
    'Free Thyroxine Index': 'FTI', 'T3 Uptake': 'T3 Uptake',
  };
  function displayName(n) { return DISPLAY_NAMES[n] || n; }

  var sysCache = null;
  function systemOf(n) {
    if (!sysCache) {
      sysCache = {};
      SYSTEM_GROUPS.forEach(function (g) { g.markers.forEach(function (k) { sysCache[k] = g.name; }); });
    }
    return sysCache[n] || 'Other';
  }
  function absDev(m) {
    if (typeof m.value !== 'number' || typeof m.fLow !== 'number' || typeof m.fHigh !== 'number') return 0;
    if (m.fDirection === 'high') return Math.abs((m.value - m.fHigh) / (m.fHigh || 1));
    if (m.fDirection === 'low') return Math.abs((m.fLow - m.value) / (m.fLow || 1));
    return 0;
  }
  function summary(markers) {
    var within = 0, above = 0, below = 0;
    markers.forEach(function (m) {
      if (m.fDirection === 'high') above++;
      else if (m.fDirection === 'low') below++;
      else if (m.fDirection === 'normal') within++;
    });
    return { within: within, above: above, below: below, total: within + above + below };
  }
  function flaggedForStrips(markers) {
    return markers.filter(function (m) { return m.fDirection === 'high' || m.fDirection === 'low'; });
  }
  function flaggedNonThyroid(markers) {
    var out = markers.filter(function (m) {
      return (m.fDirection === 'high' || m.fDirection === 'low') && THY_SHEET_MARKERS.indexOf(m.sheet) === -1;
    });
    out.sort(function (a, b) { return absDev(b) - absDev(a); });
    return out;
  }
  function stripSystem(m) {
    if (THY_SHEET_MARKERS.indexOf(m.sheet) !== -1) return 'Thyroid';
    return systemOf(m.sheet);
  }
  function trackHTML(m) {
    if (typeof m.value !== 'number' || typeof m.fLow !== 'number' || typeof m.fHigh !== 'number') {
      return '<div class="trk"><div class="trk-rail"></div></div>';
    }
    var pad = (m.fHigh - m.fLow) * 0.28;
    if (!(pad > 0)) pad = Math.abs(m.fHigh) * 0.1 || 1;
    var lo = Math.min(m.fLow, m.value), hi = Math.max(m.fHigh, m.value);
    var smin = lo - pad, smax = hi + pad, w = (smax - smin) || 1;
    function p(x) { return Math.max(0, Math.min(100, (x - smin) / w * 100)); }
    var st = m.fDirection === 'high' ? 'up' : 'down';
    var left = p(m.fLow).toFixed(1), width = (p(m.fHigh) - p(m.fLow)).toFixed(1), dot = p(m.value).toFixed(1);
    return '<div class="trk"><div class="trk-rail"></div>' +
      '<div class="trk-band" style="left:' + left + '%;width:' + width + '%"></div>' +
      '<div class="trk-dot ' + st + '" style="left:' + dot + '%"></div></div>';
  }
  function offTag(m) {
    var st = m.fDirection === 'high' ? 'up' : 'down';
    var off = m.fDirection === 'high'
      ? Math.round((m.value - m.fHigh) / Math.abs(m.fHigh || 1) * 100)
      : Math.round((m.fLow - m.value) / Math.abs(m.fLow || 1) * 100);
    return '<span class="offtag ' + st + '">' + (st === 'up' ? '▲' : '▼') + ' ' + off + '%</span>';
  }
  function markerStrip(m) {
    var st = m.fDirection === 'high' ? 'up' : 'down';
    var lab = m.labDirection === 'high' ? '<span class="lab">Lab High</span>'
            : (m.labDirection === 'low' ? '<span class="lab">Lab Low</span>' : '');
    return '<div class="strip ' + st + '">' +
      '<div class="strip-top"><span class="strip-name">' + esc(displayName(m.sheet)) + '</span>' +
      '<span class="strip-val">' + num(m.value) + '<span class="u"> ' + esc(m.units || '') + '</span></span></div>' +
      '<div class="strip-bar">' + trackHTML(m) + '</div>' +
      '<div class="strip-foot"><span class="rng">' + num(m.fLow) + '–' + num(m.fHigh) + lab + '</span>' +
      offTag(m) + '</div></div>';
  }
  function markersStrips(markers) {
    var flagged = flaggedForStrips(markers);
    var groups = {};
    flagged.forEach(function (m) { var s = stripSystem(m); (groups[s] = groups[s] || []).push(m); });
    var order = SYSTEM_GROUPS.map(function (g) { return g.name; });
    order.push('Thyroid'); order.push('Other');
    var body = '';
    order.forEach(function (sys) {
      var rows = groups[sys]; if (!rows || !rows.length) return;
      rows.sort(function (a, b) { return absDev(b) - absDev(a); });
      body += '<div class="strip-sys">' + esc(sys) + '</div><div class="strip-grid">' +
        rows.map(markerStrip).join('') + '</div>';
    });
    return '<div class="sec"><div class="sec-head"><span class="sb"></span><h2>Markers Out of Range</h2>' +
      '<span class="sd">' + flagged.length + ' markers, grouped by body system.</span></div>' +
      '<div class="strip-wrap">' + body + '</div></div>';
  }
  function chip(m) {
    var parts = [];
    if (m.fDirection === 'high') parts.push('Fnc High'); else if (m.fDirection === 'low') parts.push('Fnc Low');
    if (m.labDirection === 'high') parts.push('Lab High'); else if (m.labDirection === 'low') parts.push('Lab Low');
    var lo = (m.fDirection === 'low' || (m.fDirection !== 'high' && m.labDirection === 'low'));
    var flag = parts.length ? ' <span class="cf' + (lo ? ' lo' : '') + '">' + esc(parts.join(' · ')) + '</span>' : '';
    var unit = m.units ? (' ' + m.units) : '';
    return '<span class="chip">' + esc(displayName(m.sheet)) +
      ' <span class="cv">' + num(m.value) + esc(unit) + '</span>' + flag + '</span>';
  }
  function patternCard(hit) {
    var c = hit.category;
    var tag = c.tag ? '<span class="ptag">' + esc(c.tag) + '</span>' : '';
    return '<div class="pcard"><h3>' + esc(c.name) + '</h3>' + tag +
      '<p>' + esc(c.summary) + '</p><div class="support">Supporting markers</div>' +
      '<div class="support-list">' + hit.supporting.map(chip).join('') + '</div></div>';
  }
  function thyroidCard(hit) {
    var c = hit.category;
    var drv = (c.options || []).map(function (o) { return '<li>' + esc(o) + '</li>'; }).join('');
    return '<div class="thy-card"><div class="cat"><span class="ct">Category ' + esc(c.id) + '</span>' +
      '<h3>' + esc(c.name) + '</h3></div><div class="thy-body"><div><p>' + esc(c.summary) + '</p>' +
      '<div class="support-list">' + hit.supporting.map(chip).join('') + '</div></div>' +
      '<div class="drivers"><div class="dh">Possible drivers to evaluate</div><ul>' + drv + '</ul></div></div></div>';
  }
  function crossCard(c) {
    var chips = c.supporting.map(function (s) { return '<span>' + esc(displayName(s)) + '</span>'; }).join('');
    return '<div class="ccard"><div class="cc-cause">' + esc(c.cause) + '</div>' +
      '<div class="cc-n">' + c.supporting.length + ' markers</div><div class="cc-mk">' + chips + '</div></div>';
  }
  function causeRow(m) {
    var entry = m.manual ? MARKERS[m.manual] : null;
    var section = entry ? (m.fDirection === 'high' ? entry.elevated : entry.depressed) : null;
    var st = m.fDirection === 'high' ? 'up' : 'down';
    var stateLabel = m.fDirection === 'high' ? 'High' : 'Low';
    var causes = (section && section.causes && section.causes.length) ? section.causes : ['See clinical patterns'];
    var lis = causes.map(function (c, i) {
      return '<span class="cz' + (i === 0 ? ' primary' : '') + '">' + esc(c) + '</span>';
    }).join('');
    return '<div class="cz-row"><div class="cz-head"><span class="cz-name">' + esc(displayName(m.sheet)) +
      '</span><span class="cz-state ' + st + '">' + stateLabel + '</span></div>' +
      '<div class="cz-list">' + lis + '</div></div>';
  }
  function masthead(reportId, issued) {
    return '<div class="mast"><div class="brand"><div class="brand-mark"></div>' +
      '<div><div class="brand-name">Momentum Health and Wellness</div>' +
      '<div class="brand-sub">Functional Medicine</div></div></div>' +
      '<div class="doc-meta">Report ' + esc(reportId) + '<br>Issued ' + esc(issued) + '</div></div>';
  }
  function hero(patient, s) {
    var pc = function (n) { return s.total ? (n / s.total * 100) : 0; };
    var line = '<b>' + esc(patient.name || '') + '</b>' +
      (patient.age ? ' &nbsp;·&nbsp; Age ' + esc(patient.age) : '') +
      (patient.sex ? ' &nbsp;·&nbsp; Sex ' + esc(patient.sex) : '') +
      (patient.date ? ' &nbsp;·&nbsp; Collected ' + esc(patient.date) : '');
    var k = s.above + s.below;
    var lead = k === 0
      ? 'All <b>' + s.total + ' markers</b> reviewed sit within your optimal functional range.'
      : 'Of <b>' + s.total + ' markers</b> reviewed, most sit within your optimal functional range. <b>' + k +
        '</b> need a closer look — <b>' + s.above + '</b> running high and <b>' + s.below +
        '</b> running low — summarized below and detailed by body system.';
    return '<div class="hero"><div class="hero-l">' +
      '<span class="kicker">Lab Interpretation</span><h1>Functional Analysis Report</h1>' +
      '<div class="patient">' + line + '</div><p class="hero-lead">' + lead + '</p></div>' +
      '<div class="hero-r"><div class="prop-bar">' +
        '<span class="pok" style="width:' + pc(s.within).toFixed(1) + '%"></span>' +
        '<span class="pup" style="width:' + pc(s.above).toFixed(1) + '%"></span>' +
        '<span class="pdn" style="width:' + pc(s.below).toFixed(1) + '%"></span></div>' +
      '<div class="hero-tallies">' +
        '<div class="htal ok"><span class="bar"></span><span class="n">' + s.within + '</span><span class="l">Within</span></div>' +
        '<div class="htal up"><span class="bar"></span><span class="n">' + s.above + '</span><span class="l">Above</span></div>' +
        '<div class="htal down"><span class="bar"></span><span class="n">' + s.below + '</span><span class="l">Below</span></div></div>' +
      '<div class="legend"><span><i class="sw band"></i>Functional range</span>' +
        '<span><i class="dot up"></i>Above</span><span><i class="dot down"></i>Below</span></div></div></div>';
  }
  // Handout pages embed Drive images server-side in the GAS version. Stubbed
  // until the dysglycemia handout images are bundled as client assets.
  function handoutPagesHtml() { return ''; }

  var CSS = `
:root{
  --paper:#FFFFFF; --bg:#EBE4D9; --ink:#2C2823; --ink-soft:#5A534A; --muted:#8C8378;
  --line:#E4DCD0; --line-strong:#D6CBBC;
  --above:oklch(0.56 0.13 42); --below:oklch(0.64 0.10 78); --good:oklch(0.55 0.07 152);
  --tint:#FAF5EE; --tint-deep:#F4ECE0;
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;}
body{background:var(--paper);font-family:"IBM Plex Sans",sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;}
.doc{background:var(--paper);position:relative;}
.pbreak{break-before:page;}
.handout-img{width:100%;height:auto;display:block;}
.mast{display:flex;justify-content:space-between;align-items:flex-end;padding-bottom:12px;border-bottom:1px solid var(--line);}
.brand{display:flex;align-items:center;gap:11px;}
.brand-mark{width:28px;height:28px;border:1.5px solid var(--above);border-radius:50%;position:relative;flex:none;}
.brand-mark::after{content:"";position:absolute;inset:6.5px;border-radius:50%;background:var(--above);}
.brand-name{font-family:"Newsreader",serif;font-size:15px;font-weight:600;line-height:1.05;}
.brand-sub{font-size:8px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-top:3px;}
.doc-meta{text-align:right;font-size:8.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);line-height:1.8;}
.hero{margin-top:13px;background:var(--tint);border:1px solid var(--line);border-top:3px solid var(--above);border-radius:10px;padding:11px 18px;display:grid;grid-template-columns:1fr 3in;gap:20px;align-items:center;}
.hero .kicker{font-size:8.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--above);font-weight:600;}
.hero h1{font-family:"Newsreader",serif;font-weight:500;font-size:24px;margin:3px 0 0;letter-spacing:-0.01em;}
.hero .patient{font-family:"IBM Plex Mono",monospace;font-size:9.5px;color:var(--ink-soft);margin-top:7px;}
.hero .patient b{color:var(--ink);font-weight:600;}
.hero-lead{font-family:"Newsreader",serif;font-size:12px;line-height:1.45;color:var(--ink-soft);margin:9px 0 0;}
.hero-lead b{color:var(--ink);font-weight:600;}
.hero-r{display:flex;flex-direction:column;gap:11px;}
.prop-bar{display:flex;height:11px;border-radius:5px;overflow:hidden;gap:2px;}
.prop-bar span{display:block;}
.prop-bar .pok{background:color-mix(in oklch,var(--good) 55%,white);}
.prop-bar .pup{background:color-mix(in oklch,var(--above) 60%,white);}
.prop-bar .pdn{background:color-mix(in oklch,var(--below) 60%,white);}
.hero-tallies{display:flex;gap:8px;}
.htal{flex:1;background:var(--paper);border:1px solid var(--line);border-radius:7px;padding:9px 10px;display:flex;align-items:center;gap:8px;}
.htal .bar{width:4px;align-self:stretch;border-radius:3px;}
.htal .n{font-family:"IBM Plex Mono",monospace;font-size:20px;font-weight:500;line-height:1;}
.htal .l{font-size:8px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);line-height:1.3;}
.htal.up .n{color:var(--above);} .htal.down .n{color:var(--below);} .htal.ok .n{color:var(--good);}
.htal.up .bar{background:var(--above);} .htal.down .bar{background:var(--below);} .htal.ok .bar{background:var(--good);}
.legend{display:flex;gap:13px;flex-wrap:wrap;font-size:8.5px;color:var(--ink-soft);}
.legend span{display:flex;align-items:center;gap:5px;}
.legend .sw{width:16px;height:7px;border-radius:3px;flex:none;}
.legend .sw.band{background:color-mix(in oklch,var(--good) 30%,white);border:1px solid color-mix(in oklch,var(--good) 50%,white);}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none;}
.dot.up{background:var(--above);} .dot.down{background:var(--below);} .dot.ok{background:var(--good);}
.sec{margin-top:15px;}
.sec-head{display:flex;align-items:baseline;gap:10px;margin-bottom:10px;padding-bottom:6px;border-bottom:1.5px solid var(--ink);}
.sec-head .sb{width:9px;height:9px;background:var(--above);border-radius:2px;align-self:center;}
.sec-head h2{font-family:"Newsreader",serif;font-weight:500;font-size:18px;margin:0;}
.sec-head .sd{font-size:9px;color:var(--muted);margin-left:auto;font-style:italic;font-family:"Newsreader",serif;}
.trk{position:relative;}
.trk-rail{position:absolute;left:0;right:0;top:50%;height:2px;transform:translateY(-50%);background:var(--line-strong);border-radius:2px;}
.trk-band{position:absolute;top:50%;height:2px;transform:translateY(-50%);background:color-mix(in oklch,var(--good) 50%,white);border-radius:2px;}
.trk-dot{position:absolute;top:50%;width:9px;height:9px;border-radius:50%;transform:translate(-50%,-50%);border:1.5px solid var(--paper);}
.trk-dot.up{background:var(--above);box-shadow:0 0 0 1px var(--above);}
.trk-dot.down{background:var(--below);box-shadow:0 0 0 1px var(--below);}
.offtag{font-family:"IBM Plex Mono",monospace;font-size:9px;font-weight:600;white-space:nowrap;}
.offtag.up{color:var(--above);} .offtag.down{color:var(--below);}
.strip-wrap{margin-top:4px;}
.strip-sys{font-size:9px;letter-spacing:.15em;text-transform:uppercase;font-weight:600;color:var(--ink-soft);margin:14px 0 7px;display:flex;align-items:center;gap:8px;break-after:avoid;}
.strip-sys::after{content:"";flex:1;height:1px;background:var(--line);}
.strip-sys:first-child{margin-top:0;}
.strip-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:9px 14px;}
.strip{border-left:2.5px solid var(--line-strong);padding:2px 0 4px 9px;break-inside:avoid;}
.strip.up{border-left-color:color-mix(in oklch,var(--above) 55%,white);}
.strip.down{border-left-color:color-mix(in oklch,var(--below) 55%,white);}
.strip-top{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:baseline;}
.strip-name{font-size:10.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}
.strip-val{font-family:"IBM Plex Mono",monospace;font-size:10.5px;font-weight:600;}
.strip-val .u{font-size:7px;color:var(--muted);font-weight:400;}
.strip-bar{margin:6px 0 3px;}
.strip-bar .trk{height:10px;}
.strip-foot{display:flex;justify-content:space-between;align-items:center;gap:6px;}
.strip-foot .rng{font-family:"IBM Plex Mono",monospace;font-size:7.5px;color:var(--good);}
.strip-foot .lab{font-size:6.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:600;color:var(--above);border:1px solid color-mix(in oklch,var(--above) 30%,white);padding:1px 4px;border-radius:3px;margin-left:5px;}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:9.5px;background:var(--tint-deep);border:1px solid var(--line);border-radius:5px;padding:3px 8px;}
.chip .cv{font-family:"IBM Plex Mono",monospace;font-weight:500;}
.chip .cf{font-size:7px;letter-spacing:.05em;text-transform:uppercase;color:var(--above);font-weight:600;}
.chip .cf.lo{color:var(--below);}
.pat-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px;}
.pcard{border:1px solid var(--line);border-radius:9px;padding:12px 14px;border-top:3px solid var(--above);break-inside:avoid;}
.pcard h3{font-family:"Newsreader",serif;font-size:15px;font-weight:600;margin:0 0 4px;line-height:1.15;}
.pcard .ptag{font-size:7.5px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;color:var(--muted);background:#F2ECE2;padding:2px 7px;border-radius:3px;display:inline-block;margin-bottom:8px;}
.pcard p{font-size:10px;line-height:1.5;color:var(--ink-soft);margin:0 0 10px;}
.support{font-size:8px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;}
.support-list{display:flex;flex-wrap:wrap;gap:6px;}
.thy-card{border:1px solid var(--line);border-radius:9px;padding:12px 15px;margin-bottom:10px;break-inside:avoid;}
.thy-card .cat{display:inline-flex;align-items:center;gap:8px;margin-bottom:6px;}
.thy-card .cat .ct{font-family:"IBM Plex Mono",monospace;font-size:9px;font-weight:600;color:var(--paper);background:var(--above);padding:2px 8px;border-radius:4px;letter-spacing:.04em;}
.thy-card h3{font-family:"Newsreader",serif;font-size:15px;font-weight:600;margin:0;display:inline;}
.thy-card p{font-size:10px;line-height:1.5;color:var(--ink-soft);margin:6px 0 9px;}
.thy-body{display:grid;grid-template-columns:1fr 1.1fr;gap:18px;align-items:start;}
.drivers .dh{font-size:8px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;}
.drivers ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;}
.drivers li{font-size:9.5px;line-height:1.4;color:var(--ink-soft);padding-left:13px;position:relative;}
.drivers li::before{content:"";position:absolute;left:0;top:5px;width:4px;height:4px;border-radius:50%;border:1px solid var(--muted);}
.cross-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;}
.ccard{border:1px solid var(--line);border-radius:9px;padding:14px;text-align:center;break-inside:avoid;}
.ccard .cc-cause{font-size:13px;font-weight:600;margin-bottom:9px;}
.ccard .cc-n{font-family:"IBM Plex Mono",monospace;font-size:9px;color:var(--above);font-weight:600;letter-spacing:.06em;margin-bottom:9px;}
.ccard .cc-mk{display:flex;gap:5px;justify-content:center;flex-wrap:wrap;}
.ccard .cc-mk span{font-family:"IBM Plex Mono",monospace;font-size:8.5px;background:var(--tint-deep);border:1px solid var(--line);padding:3px 7px;border-radius:4px;color:var(--ink-soft);}
.cause-grid{columns:2;column-gap:26px;}
.cz-row{break-inside:avoid;padding:7px 0;border-bottom:1px solid var(--line);}
.cz-head{display:flex;align-items:baseline;gap:8px;margin-bottom:3px;}
.cz-name{font-size:11.5px;font-weight:600;}
.cz-state{font-size:7.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:600;}
.cz-state.up{color:var(--above);} .cz-state.down{color:var(--below);}
.cz-list{display:flex;flex-wrap:wrap;gap:4px 6px;}
.cz{font-size:9.5px;color:var(--ink-soft);line-height:1.3;}
.cz:not(:last-child)::after{content:"·";margin-left:6px;color:var(--line-strong);}
.cz.primary{color:var(--ink);font-weight:500;}
@page{size:letter;}
`;

  // ───────────── 5. full HTML assembly (port of _apexBuildReportHtml) ─────────
  function buildReportHtml(patient, markers, thyroidHits, computedHits, sharedCauses) {
    var s = summary(markers);
    var now = new Date();
    var pad2 = function (n) { return String(n).padStart(2, '0'); };
    var reportId = 'FA-' + now.getFullYear() + '-' + pad2(now.getMonth() + 1) + pad2(now.getDate());
    var issued = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    var block1 = masthead(reportId, issued) + hero(patient, s) + markersStrips(markers);

    var block2 = '';
    if (computedHits.length) {
      block2 += '<div class="sec"><div class="sec-head"><span class="sb"></span>' +
        '<h2>Interpretation — Clinical Patterns</h2></div><div class="pat-grid">' +
        computedHits.map(patternCard).join('') + '</div></div>';
    }
    if (thyroidHits.length) {
      block2 += '<div class="sec"><div class="sec-head"><span class="sb"></span>' +
        '<h2>Thyroid Pattern Analysis</h2></div>' + thyroidHits.map(thyroidCard).join('') + '</div>';
    }
    if (sharedCauses.length) {
      var topCross = sharedCauses.slice(0, 6);
      block2 += '<div class="sec"><div class="sec-head"><span class="sb"></span>' +
        '<h2>Cross-Marker Patterns</h2><span class="sd">Causes recurring across ≥2 flagged markers.</span></div>' +
        '<div class="cross-grid">' + topCross.map(crossCard).join('') + '</div></div>';
    }
    if (block2) block2 = '<div class="pbreak"></div>' + block2;

    var causeMarkers = flaggedNonThyroid(markers);
    var block3 = '';
    if (causeMarkers.length) {
      block3 = '<div class="pbreak"></div><div class="sec"><div class="sec-head"><span class="sb"></span>' +
        '<h2>Marker Causes</h2><span class="sd">Per-marker possible causes, most likely first.</span></div>' +
        '<div class="cause-grid">' + causeMarkers.map(causeRow).join('') + '</div></div>';
    }

    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
      '<link rel="preconnect" href="https://fonts.googleapis.com">' +
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      '<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">' +
      '<style>' + CSS + '</style></head><body><div class="doc">' +
      block1 + block2 + block3 + handoutPagesHtml() + '</div></body></html>';
  }

  // ───────────── public ──────────────────────────────────────────────────────
  function build(patient, parsedResults, ranges, APEX) {
    setConfig(APEX);
    var markers = buildMarkers(parsedResults, ranges);
    var thyroidHits = detectPatterns(THY_CATS, markers);
    var computedHits = detectPatterns(CMP_PATS, markers);
    var sharedCauses = aggregateCauses(markers);
    return buildReportHtml(patient, markers, thyroidHits, computedHits, sharedCauses);
  }

  return { build: build, _buildMarkers: buildMarkers, _detectPatterns: detectPatterns,
           _setConfig: setConfig, _summary: summary };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ApexReport;
