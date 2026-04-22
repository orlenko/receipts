// Comparison harness orchestration: pick folders → parse CSVs → run pipeline
// per receipt → diff each field against ground truth → update stats table.

import { runPipeline } from './pipeline.js';
import { compareFields } from './fields.js';

const state = {
  raw: new Map(),       // filename → File
  gt: new Map(),        // filename → ground-truth field record
  running: false,
  cancel: false,
  stats: freshStats(),
  thumbUrls: [],        // object URLs for thumb blobs; revoked on reset
};

const $ = (id) => document.getElementById(id);
const rawInput = $('raw-input');
const gtInput = $('gt-input');
const runBtn = $('run-btn');
const stopBtn = $('stop-btn');
const limitInput = $('limit-input');
const logEl = $('log');
const resultsBody = $('results-body');

function freshStats() {
  return { processed: 0, total: 0, corners: 0, brand: 0, date: 0, amount: 0, tax: 0, totalTime: 0 };
}

function log(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.textContent = line + '\n' + logEl.textContent;
}

// ── file pickers ────────────────────────────────────────────────────

rawInput.addEventListener('change', (e) => {
  state.raw.clear();
  for (const f of e.target.files) {
    if (/\.(jpe?g|png)$/i.test(f.name)) {
      // webkitdirectory gives us names with relative paths; the basename is our key.
      const base = f.name.split('/').pop();
      state.raw.set(base, f);
    }
  }
  log(`Raw folder: ${state.raw.size} image(s).`);
  refreshRunButton();
});

gtInput.addEventListener('change', async (e) => {
  state.gt.clear();
  const csvFiles = Array.from(e.target.files).filter((f) => /(?:^|\/)(ok|review)\.csv$/i.test(f.webkitRelativePath || f.name));
  if (!csvFiles.length) {
    log(`Ground truth folder: no ok.csv or review.csv found.`);
    refreshRunButton();
    return;
  }
  for (const f of csvFiles) {
    try {
      const text = await f.text();
      const rows = parseCSV(text);
      for (const row of rows) {
        const fn = (row.filename || '').trim();
        if (!fn) continue;
        state.gt.set(fn, {
          brand: row.brand || '',
          vendor: row.vendor || '',
          date: row.date || null,
          amount: toNum(row.amount),
          tax: toNum(row.tax),
          subtotal: toNum(row.subtotal),
          currency: row.currency || '',
          quality: row.quality || '',
          status: row.status || 'ok',
        });
      }
      log(`  ${f.name}: ${rows.length} row(s).`);
    } catch (err) {
      log(`  ${f.name}: parse error — ${err.message}`);
    }
  }
  log(`Ground truth: ${state.gt.size} record(s) loaded.`);
  refreshRunButton();
});

function toNum(s) {
  if (s == null || s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function refreshRunButton() {
  runBtn.disabled = !(state.raw.size && state.gt.size);
}

// Minimal CSV parser — handles UTF-8 BOM and double-quoted fields with commas.
function parseCSV(text) {
  const stripped = text.replace(/^﻿/, '');
  const lines = stripped.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => obj[h] = cells[idx] ?? '');
    rows.push(obj);
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else if (c === '"' && cur === '') {
      inQ = true;
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ── run loop ────────────────────────────────────────────────────────

runBtn.addEventListener('click', run);
stopBtn.addEventListener('click', () => { state.cancel = true; log('Stop requested…'); });

async function run() {
  if (state.running) return;
  state.running = true;
  state.cancel = false;
  runBtn.disabled = true;
  stopBtn.disabled = false;

  resetResults();
  const backendName = document.querySelector('input[name="backend"]:checked').value;
  log(`Loading backend: ${backendName}…`);

  let backend;
  try {
    if (backendName === 'tesseract') backend = await import('./backends/tesseract.js');
    else backend = await import('./backends/paddle.js');
  } catch (err) {
    log(`Backend failed to load: ${err.message}`);
    return finish();
  }

  // Work list: raw files that also have a ground-truth record, capped by limit.
  const limit = parseInt(limitInput.value, 10) || 20;
  const workList = [];
  for (const [name, file] of state.raw) {
    if (state.gt.has(name)) workList.push({ name, file });
    if (workList.length >= limit) break;
  }
  state.stats.total = workList.length;
  updateStatsUI();
  if (!workList.length) {
    log(`No raw file matches a ground-truth row. Check folder pairing.`);
    return finish();
  }
  log(`Processing ${workList.length} receipt(s)…`);

  for (const item of workList) {
    if (state.cancel) { log('Cancelled.'); break; }
    const idx = state.stats.processed + 1;
    try {
      log(`[${idx}/${workList.length}] ${item.name} …`);
      const gt = state.gt.get(item.name);
      const res = await runPipeline(item.file, backend);
      const cmp = compareFields(gt, res.fields);
      appendRow(item, res, gt, cmp);
      updateStats(res, cmp);
      updateStatsUI();
      const t = res.timings;
      log(`    total=${(t.total/1000).toFixed(1)}s  prep=${Math.round(t.prep)}  corners=${Math.round(t.corners)}  warp=${Math.round(t.warp)}  ocr=${(t.ocr/1000).toFixed(1)}s${memSuffix()}`);
    } catch (err) {
      console.error(err);
      log(`[${idx}/${workList.length}] ERROR ${item.name}: ${err.message}`);
    }
    // Let the browser paint, GC, and check tab health between receipts.
    await new Promise((r) => setTimeout(r, 50));
  }

  log(`Done.`);
  finish();
}

function finish() {
  state.running = false;
  runBtn.disabled = !(state.raw.size && state.gt.size);
  stopBtn.disabled = true;
}

function resetResults() {
  resultsBody.innerHTML = '';
  for (const url of state.thumbUrls) URL.revokeObjectURL(url);
  state.thumbUrls = [];
  state.stats = freshStats();
  updateStatsUI();
}

function memSuffix() {
  // Chrome-only. Best-effort diagnostic so a leaking build is visible in the log.
  const m = performance.memory;
  if (!m) return '';
  return `  heap=${Math.round(m.usedJSHeapSize / 1024 / 1024)}MB`;
}

function updateStats(res, cmp) {
  state.stats.processed++;
  state.stats.totalTime += res.timings.total;
  if (res.cornersFound) state.stats.corners++;
  if (cmp.brand === 'match' || cmp.brand === 'partial') state.stats.brand++;
  if (cmp.date === 'match') state.stats.date++;
  if (cmp.amount === 'match') state.stats.amount++;
  if (cmp.tax === 'match') state.stats.tax++;
}

function updateStatsUI() {
  const s = state.stats;
  const pct = (a, b) => (b > 0 ? `${Math.round((100 * a) / b)}%` : '—');
  $('stat-processed').innerHTML = `${s.processed}<span class="stat-pct">/ ${s.total}</span>`;
  $('stat-corners').innerHTML   = `${s.corners}<span class="stat-pct">${pct(s.corners, s.processed)}</span>`;
  $('stat-brand').innerHTML     = `${s.brand}<span class="stat-pct">${pct(s.brand, s.processed)}</span>`;
  $('stat-date').innerHTML      = `${s.date}<span class="stat-pct">${pct(s.date, s.processed)}</span>`;
  $('stat-amount').innerHTML    = `${s.amount}<span class="stat-pct">${pct(s.amount, s.processed)}</span>`;
  $('stat-tax').innerHTML       = `${s.tax}<span class="stat-pct">${pct(s.tax, s.processed)}</span>`;
  $('stat-time').textContent    = s.processed > 0 ? `${(s.totalTime / s.processed / 1000).toFixed(1)} s` : '— s';
}

// ── table rendering ─────────────────────────────────────────────────

function appendRow(item, res, gt, cmp) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="num">${state.stats.processed + 1}</td>
    <td class="filename">${esc(item.name)}</td>
    <td class="thumb"></td>
    <td class="${klass(cmp.brand)}">${fmtPair(gt.brand, res.fields.brand)}</td>
    <td class="${klass(cmp.date)}">${fmtPair(gt.date, res.fields.date)}</td>
    <td class="num ${klass(cmp.amount)}">${fmtPair(fmtNum(gt.amount), fmtNum(res.fields.amount))}</td>
    <td class="num ${klass(cmp.tax)}">${fmtPair(fmtNum(gt.tax), fmtNum(res.fields.tax))}</td>
    <td class="num">${(res.timings.total / 1000).toFixed(1)}s</td>
    <td class="notes">${res.cornersFound ? 'corners ok' : '<em class="placeholder">no corners</em>'}</td>
  `;
  // Render the thumb via an object URL on the pre-downscaled blob. Way less
  // memory than a data URL of a multi-MB canvas.
  const thumbCell = tr.querySelector('.thumb');
  if (res.thumbBlob) {
    const url = URL.createObjectURL(res.thumbBlob);
    state.thumbUrls.push(url);
    const thumb = document.createElement('img');
    thumb.src = url;
    thumbCell.appendChild(thumb);
  }
  resultsBody.appendChild(tr);
}

function klass(code) {
  if (code === 'match') return 'match';
  if (code === 'partial') return 'partial';
  if (code === 'miss') return 'mismatch';
  return 'na';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtPair(gt, local) {
  const g = gt == null || gt === '' ? '<em class="placeholder">—</em>' : esc(String(gt));
  const l = local == null || local === '' ? '<em class="placeholder">—</em>' : esc(String(local));
  return `${g} → ${l}`;
}

function fmtNum(v) {
  if (v == null) return '';
  if (typeof v === 'number') return v.toFixed(2);
  return String(v);
}
