// Comparison harness: one folder picker points at sample-data/processed/,
// we pair each subdir's processed.jpg with its extracted.json, OCR the JPEG,
// and diff the extracted fields against the JSON (which is the OpenAI ground
// truth). No OpenCV anywhere; the JPEGs are already warped.

import { runPipeline } from './pipeline.js';
import { compareFields } from './fields.js';

const state = {
  entries: new Map(),   // subdir name → { jpg: File, gt: object }
  running: false,
  cancel: false,
  stats: freshStats(),
  thumbUrls: [],        // object URLs we create per row; revoked on reset
};

const $ = (id) => document.getElementById(id);
const folderInput = $('folder-input');
const runBtn = $('run-btn');
const stopBtn = $('stop-btn');
const limitInput = $('limit-input');
const logEl = $('log');
const resultsBody = $('results-body');

function freshStats() {
  return { processed: 0, total: 0, brand: 0, date: 0, amount: 0, tax: 0, totalTime: 0 };
}

// Bounded log: keep only the newest N lines so this can't go O(N²) even if
// something downstream gets chatty.
const LOG_MAX_LINES = 80;
const logLines = [];
function log(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  logLines.unshift(line);
  if (logLines.length > LOG_MAX_LINES) logLines.length = LOG_MAX_LINES;
  logEl.textContent = logLines.join('\n');
}

// Double rAF: forces a paint so the most recent log line actually shows
// BEFORE the next blocking task starts.
async function yieldToPaint() {
  await new Promise((r) => requestAnimationFrame(() => r()));
  await new Promise((r) => requestAnimationFrame(() => r()));
}

function memSuffix() {
  const m = performance.memory;
  if (!m) return '';
  return `  heap=${Math.round(m.usedJSHeapSize / 1024 / 1024)}MB`;
}

// ── folder parsing ──────────────────────────────────────────────────

folderInput.addEventListener('change', async (e) => {
  state.entries.clear();

  // Group files by their immediate parent dir; match processed.jpg with
  // extracted.json within each dir. Top-level files (ok.csv, review.csv,
  // .DS_Store) are ignored — we don't need CSVs; the per-subdir JSON has
  // everything and it's already associated with the right image.
  const bySubdir = new Map();
  for (const f of e.target.files) {
    const path = f.webkitRelativePath || f.name;
    const parts = path.split('/');
    if (parts.length < 3) continue;
    const subdir = parts[parts.length - 2];
    const filename = parts[parts.length - 1];
    if (filename !== 'processed.jpg' && filename !== 'extracted.json') continue;
    if (!bySubdir.has(subdir)) bySubdir.set(subdir, {});
    const entry = bySubdir.get(subdir);
    if (filename === 'processed.jpg') entry.jpg = f;
    else entry.json = f;
  }

  let kept = 0;
  for (const [name, entry] of bySubdir) {
    if (!entry.jpg || !entry.json) continue;
    try {
      const gt = JSON.parse(await entry.json.text());
      state.entries.set(name, {
        jpg: entry.jpg,
        gt: {
          brand: gt.brand || '',
          vendor: gt.vendor || '',
          date: gt.date || null,
          amount: toNum(gt.amount),
          tax: toNum(gt.tax),
          subtotal: toNum(gt.subtotal),
          currency: gt.currency || '',
          quality: gt.quality || '',
        },
      });
      kept++;
    } catch (err) {
      // Malformed JSON — skip silently; too many to log individually.
    }
  }
  log(`Loaded ${kept} receipt(s) with processed.jpg + extracted.json.`);
  refreshRunButton();
});

function toNum(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function refreshRunButton() {
  runBtn.disabled = state.entries.size === 0;
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
  await yieldToPaint();

  // Cache-bust the dynamic import — browsers cache ES module URLs aggressively
  // and a normal reload sometimes doesn't fetch backends/*.js even after edits.
  // Bumping this string forces a fresh fetch without needing DevTools cache tricks.
  const BACKEND_V = '3';
  let backend;
  try {
    if (backendName === 'tesseract') backend = await import(`./backends/tesseract.js?v=${BACKEND_V}`);
    else backend = await import(`./backends/paddle.js?v=${BACKEND_V}`);
  } catch (err) {
    log(`Backend failed to load: ${err.message}`);
    return finish();
  }

  if (backend.preload) {
    try {
      await backend.preload((msg) => log(msg));
    } catch (err) {
      log(`Backend warm-up failed: ${err.message}`);
      return finish();
    }
  }
  log(`${backendName} ready.${memSuffix()}`);
  await yieldToPaint();

  const limit = parseInt(limitInput.value, 10) || 10;
  const workList = [...state.entries.entries()].slice(0, limit).map(([name, data]) => ({ name, ...data }));
  state.stats.total = workList.length;
  updateStatsUI();

  log(`Processing ${workList.length} receipt(s)…`);
  for (const item of workList) {
    if (state.cancel) { log('Cancelled.'); break; }
    const idx = state.stats.processed + 1;
    try {
      log(`[${idx}/${workList.length}] ${item.name} …`);
      const res = await runPipeline(item.jpg, backend);
      const cmp = compareFields(item.gt, res.fields);
      appendRow(item, res, item.gt, cmp);
      updateStats(res, cmp);
      updateStatsUI();
      const t = res.timings;
      log(`    total=${(t.total / 1000).toFixed(1)}s  prep=${Math.round(t.prep)}  ocr=${(t.ocr / 1000).toFixed(1)}s  conf=${(res.ocrConfidence * 100).toFixed(0)}%${memSuffix()}`);
    } catch (err) {
      console.error(err);
      log(`[${idx}/${workList.length}] ERROR ${item.name}: ${err.message}`);
    }
    // Yield so the browser can paint, GC, and check tab health.
    await new Promise((r) => setTimeout(r, 50));
  }

  log('Done.');
  finish();
}

function finish() {
  state.running = false;
  runBtn.disabled = state.entries.size === 0;
  stopBtn.disabled = true;
}

function resetResults() {
  resultsBody.innerHTML = '';
  for (const url of state.thumbUrls) URL.revokeObjectURL(url);
  state.thumbUrls = [];
  state.stats = freshStats();
  updateStatsUI();
}

function updateStats(res, cmp) {
  state.stats.processed++;
  state.stats.totalTime += res.timings.total;
  if (cmp.brand === 'match' || cmp.brand === 'partial') state.stats.brand++;
  if (cmp.date === 'match') state.stats.date++;
  if (cmp.amount === 'match') state.stats.amount++;
  if (cmp.tax === 'match') state.stats.tax++;
}

function updateStatsUI() {
  const s = state.stats;
  const pct = (a, b) => (b > 0 ? `${Math.round((100 * a) / b)}%` : '—');
  $('stat-processed').innerHTML = `${s.processed}<span class="stat-pct">/ ${s.total}</span>`;
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
    <td class="num">${Math.round(res.ocrConfidence * 100)}%</td>
  `;
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
