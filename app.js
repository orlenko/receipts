// receipts — browser orchestration
// BYO OpenAI API key; images + key stay local. Calls api.openai.com directly.

import { warpImage, outputSizeFromCorners, validCorners } from './warp.js';
import { listBatches, getBatchRecord, deleteBatchAndFiles } from './db.js';
import {
  submitBatch, refreshStatus, fetchAndProcess, hydrateResults, TERMINAL_STATES,
} from './batch.js';
import {
  beginOpenRouterAuth, completeOpenRouterAuth, isReturningFromOpenRouter,
} from './auth.js';

const EXTRACTION_PROMPT = `You are extracting structured data from a photo of a receipt.

The image may show the receipt at any angle (sideways, upside-down, rotated)
on an arbitrary background.

Return STRICT JSON with these keys:

  corners (array of 4 [x, y] pairs, each a fraction in [0, 1] of image width
           and height; no nulls):
    The four corners of the receipt in this order:
      1. top-left of the receipt    (the "top" is the side where the header /
                                     store name is printed, read normally)
      2. top-right                   (same top edge, other end)
      3. bottom-right
      4. bottom-left
    These are in RECEIPT-READING ORIENTATION, not image-frame orientation.
    A perspective transform mapping these points to a rectangle in the listed
    order must produce an upright, readable receipt.
    If a corner is off-screen or occluded, give your best estimate clipped to [0, 1].

  vendor    (string) - human-friendly label combining brand + location,
                       e.g. "Rona Coquitlam, BC" or "Canadian Tire #600 Toronto Eaton Centre".
  brand     (string) - chain or store name alone, e.g. "Rona".
  address   (string) - street address as printed, single line, or "".
  city      (string) - or "".
  region    (string) - province/state code or name, or "".
  country   (string) - or "".
  phone     (string) - printed phone number, or "".
  amount    (number) - grand total paid, no currency symbol.
  subtotal  (number) - pre-tax subtotal, or null if not shown.
  tax       (number) - total tax (VAT/HST/GST/sales tax). 0 if none shown.
  date      (string) - transaction date, ISO YYYY-MM-DD.
  currency  (string) - ISO 4217 code if determinable, else "".

  quality   (string) - one of:
              "good"        - confident in all critical fields (brand, date, amount).
              "poor"        - readable but smudged/torn/obscured; some uncertainty.
              "unreadable"  - image quality prevents reliable extraction.
  notes     (string) - if quality is not "good", briefly state what was hard to read.
                       Empty string if quality == "good".

For text fields you cannot read confidently, use null. For optional strings
(address/city/region/country/phone), use "" if absent.
Output JSON only, no prose, no markdown fences.`;

// Two providers supported:
//   - 'openai':     direct to api.openai.com with the user's own key. Cheapest,
//                   supports batch mode (~50% off via the Batch API).
//   - 'openrouter': via openrouter.ai using a PKCE-OAuth-issued key. One extra
//                   hop in the trust chain, ~5% markup, batch API not exposed.
const MODEL_OPENAI = 'gpt-5.4';
const MODEL_OPENROUTER = 'openai/gpt-5.4';
const API_BASE = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

const API_MAX_EDGE = 1568;
const KEY_STORAGE = 'receipts.openai_key';        // legacy; still read on first load
const PROVIDER_STORAGE = 'receipts.provider';     // 'openai' | 'openrouter'
const PROVIDER_KEY_STORAGE = 'receipts.provider_key';
const MODE_STORAGE = 'receipts.mode';

// ---------- state ----------
function loadInitialAuth() {
  // Migrate the v1 single-key storage into the new (provider, key) shape.
  const provider = localStorage.getItem(PROVIDER_STORAGE);
  const providerKey = localStorage.getItem(PROVIDER_KEY_STORAGE);
  if (provider && providerKey) return { provider, apiKey: providerKey };
  const legacy = localStorage.getItem(KEY_STORAGE);
  if (legacy) {
    localStorage.setItem(PROVIDER_STORAGE, 'openai');
    localStorage.setItem(PROVIDER_KEY_STORAGE, legacy);
    return { provider: 'openai', apiKey: legacy };
  }
  return { provider: 'openai', apiKey: '' };
}

const initialAuth = loadInitialAuth();
const state = {
  provider: initialAuth.provider,        // 'openai' | 'openrouter'
  apiKey: initialAuth.apiKey,
  mode: localStorage.getItem(MODE_STORAGE) === 'batch' ? 'batch' : 'live',
  queue: [], // [{id, file, thumbUrl}]
  results: [], // [{id, file, fields, status, reasons, processedBlob, processedUrl}]
};

function persistAuth(provider, key) {
  state.provider = provider;
  state.apiKey = key;
  if (provider && key) {
    localStorage.setItem(PROVIDER_STORAGE, provider);
    localStorage.setItem(PROVIDER_KEY_STORAGE, key);
  }
}
function clearAuth() {
  state.apiKey = '';
  localStorage.removeItem(KEY_STORAGE);
  localStorage.removeItem(PROVIDER_KEY_STORAGE);
  // keep the provider preference so the right tab is selected next time
}

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const keyInput = $('api-key');
const saveKeyBtn = $('save-key');
const clearKeyBtn = $('clear-key');

const orSignoutBtn = $('or-signout');
const authOpts = document.querySelectorAll('.auth-opt');

const connectDrawer = $('connect-drawer');
const connChip = $('conn-chip');
const connChipLabel = connChip?.querySelector('.conn-chip-label');
const infoBtn = $('info-btn');
const infoPanel = $('info-panel');

const dropZone = $('drop-zone');
const fileInput = $('file-input');

const workSection = $('work');
const queueSummary = $('queue-summary');
const rowsList = $('rows');
const rowTemplate = $('row-tpl');
const modeLiveBtn = $('mode-live');
const modeBatchBtn = $('mode-batch');
const modeNote = $('mode-note');
const runBtn = $('run-btn');
const clearQueueBtn = $('clear-queue-btn');

const batchesSection = $('batches-section');
const batchList = $('batch-list');

const downloadAllBtn = $('download-all-btn');

const PLATFORM_BATCH_URL = (id) => `https://platform.openai.com/batches/${id}`;

// ---------- connection chrome ----------
// Drives body[data-app-state] (which the design uses to swap layout between
// first-visit, connected, and working) plus the top-bar chip + drawer collapse.
//
// State machine:
//   no key                    → 'first'      drawer open, chip hidden
//   key + no rows             → 'connected'  drawer collapsed, chip in bar
//   key + queue or results    → 'working'    same chrome, padding tweak only
//
// The chip click can force the drawer back open without us re-collapsing it
// the next time renderKeyStatus runs (e.g. after the user pastes a key).
let drawerForcedOpen = false;
function syncConnectionUI() {
  const connected = !!state.apiKey;
  const hasRows = state.queue.length || state.results.length;
  document.body.dataset.appState = !connected ? 'first' : (hasRows ? 'working' : 'connected');

  if (connected) {
    if (connChip) {
      connChip.hidden = false;
      const providerLabel = state.provider === 'openrouter' ? 'OpenRouter' : 'OpenAI';
      if (connChipLabel) connChipLabel.textContent = `${providerLabel} · …${state.apiKey.slice(-4)}`;
    }
    if (connectDrawer && !drawerForcedOpen) {
      connectDrawer.hidden = true;
      connChip?.setAttribute('aria-expanded', 'false');
    }
  } else {
    if (connChip) {
      connChip.hidden = true;
      connChip.setAttribute('aria-expanded', 'false');
    }
    if (connectDrawer) connectDrawer.hidden = false;
    drawerForcedOpen = false;
  }
}
connChip?.addEventListener('click', () => {
  if (!connectDrawer) return;
  const opening = connectDrawer.hidden;
  connectDrawer.hidden = !opening;
  drawerForcedOpen = opening;
  connChip.setAttribute('aria-expanded', String(opening));
  if (opening) connectDrawer.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// "?" popover in the top bar. Closes on: outside-the-wrapper click, Escape,
// or activating any of its own anchor links (so the menu collapses while the
// browser scrolls to the disclosure section).
const infoMenuWrap = infoBtn?.closest('.info-menu');
function closeInfoPanel() {
  if (!infoPanel || infoPanel.hidden) return;
  infoPanel.hidden = true;
  infoBtn?.setAttribute('aria-expanded', 'false');
}
infoBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!infoPanel) return;
  const opening = infoPanel.hidden;
  infoPanel.hidden = !opening;
  infoBtn.setAttribute('aria-expanded', String(opening));
});
document.addEventListener('click', (e) => {
  if (!infoPanel || infoPanel.hidden) return;
  if (infoMenuWrap && infoMenuWrap.contains(e.target)) return;
  closeInfoPanel();
});
infoPanel?.addEventListener('click', (e) => {
  if (e.target.closest('a')) closeInfoPanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeInfoPanel();
});

// ---------- API key / provider auth ----------
// Each auth option has two views: a default <div class="auth-form"> (input or
// "Sign in" button) and an <div class="auth-active"> ("✓ saved …xyz [Clear]")
// shown only when that option is the one currently providing the credential.
function renderKeyStatus() {
  const activeProvider = state.apiKey ? state.provider : null;
  authOpts.forEach((opt) => {
    const provider = opt.dataset.provider;
    const form = opt.querySelector('.auth-form');
    const active = opt.querySelector('.auth-active');
    const isActive = provider === activeProvider;
    if (form)   form.hidden   = isActive;
    if (active) active.hidden = !isActive;
    if (isActive) {
      const suffix = opt.querySelector('.key-suffix');
      if (suffix) suffix.textContent = `…${state.apiKey.slice(-4)}`;
    }
  });
  if (keyInput) keyInput.value = '';

  // Batch mode is OpenAI-only (OpenRouter doesn't expose the Batch API).
  if (modeBatchBtn) {
    const orMode = state.provider === 'openrouter' && !!state.apiKey;
    modeBatchBtn.disabled = orMode;
    modeBatchBtn.title = orMode
      ? 'Batch mode is only available with a direct OpenAI key (OpenRouter doesn\u2019t expose the Batch API)'
      : '';
    if (orMode && state.mode === 'batch') setMode('live');
  }
  syncConnectionUI();
}
function saveOpenAiKeyFromInput() {
  const v = keyInput.value.trim();
  if (!v) return;
  persistAuth('openai', v);
  renderKeyStatus();
}
saveKeyBtn.addEventListener('click', saveOpenAiKeyFromInput);
// Auto-save on blur after a paste/edit (no need to hunt for the green button).
keyInput.addEventListener('change', saveOpenAiKeyFromInput);
keyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveOpenAiKeyFromInput(); }
});
clearKeyBtn.addEventListener('click', () => {
  clearAuth();
  renderKeyStatus();
});
orSignoutBtn?.addEventListener('click', () => {
  clearAuth();
  renderKeyStatus();
});

// OpenRouter PKCE: redirect to /auth, user signs in (or creates an account on
// OpenRouter's side), they're redirected back here with ?code=... which the
// init block picks up and exchanges for a long-lived API key.
const orLoginBtn = $('or-login');
orLoginBtn?.addEventListener('click', async () => {
  try { await beginOpenRouterAuth(); }
  catch (e) { alert(`Could not start OpenRouter sign-in: ${e.message}`); }
});

// ---------- drop zone ----------
['dragenter', 'dragover'].forEach(evt => {
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('dragover'); });
});
['dragleave', 'drop'].forEach(evt => {
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('dragover'); });
});
dropZone.addEventListener('drop', e => addFiles(e.dataTransfer.files));
fileInput.addEventListener('change', e => addFiles(e.target.files));

// Whole drop zone acts as a click target for the file picker. The "Or choose
// files" label already opens the picker natively via <label for>; bail when
// the click came from the label so we don't double-trigger.
dropZone.addEventListener('click', (e) => {
  if (e.target.closest('label.file-pick')) return;
  fileInput.click();
});
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

function addFiles(fileList) {
  const files = Array.from(fileList).filter(f => /^image\/(jpeg|png)$/.test(f.type));
  if (!files.length) return;
  for (const f of files) {
    const id = crypto.randomUUID();
    const thumbUrl = URL.createObjectURL(f);
    state.queue.push({ id, file: f, thumbUrl });
  }
  renderRows();
}
// The redesign uses a single #rows list for both queued and processed items.
// Each row uses the <template id="row-tpl"> in index.html and transitions
// through data-state values: queued → working → ok | review | error.
function renderRows() {
  syncConnectionUI();
  const haveAny = state.queue.length || state.results.length;
  workSection.hidden = !haveAny;
  if (!haveAny) {
    rowsList.innerHTML = '';
    queueSummary.textContent = '';
    downloadAllBtn.hidden = true;
    return;
  }
  const resultsById = new Map(state.results.map(r => [r.id, r]));
  const rendered = new Set();
  rowsList.innerHTML = '';
  let i = 0;
  for (const item of state.queue) {
    i++;
    rowsList.appendChild(buildRow(item, resultsById.get(item.id), i));
    rendered.add(item.id);
  }
  // Hydrated batch results may not have a queue entry — render those after.
  for (const r of state.results) {
    if (rendered.has(r.id)) continue;
    i++;
    rowsList.appendChild(buildRow({ id: r.id, file: r.file, thumbUrl: null }, r, i));
  }
  const total = i;
  const done = state.results.length;
  queueSummary.textContent = done
    ? `${String(done).padStart(2, '0')}/${String(total).padStart(2, '0')} done`
    : `${String(total).padStart(2, '0')} file${total === 1 ? '' : 's'} ready`;
  downloadAllBtn.hidden = !state.results.some(r => r.status === 'ok' || r.status === 'review');
}

function buildRow(item, result, idx) {
  const node = rowTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = item.id;
  node.querySelector('.row-idx').textContent = String(idx).padStart(2, '0');
  const thumb = node.querySelector('.row-thumb');
  if (item.thumbUrl) thumb.src = item.thumbUrl;
  else if (result?.processedUrl) thumb.src = result.processedUrl;
  else thumb.removeAttribute('src');
  node.querySelector('.row-name').textContent = item.file?.name || '(unnamed)';

  if (!result) {
    node.dataset.state = 'queued';
    setRowStatus(node, 'queued', '');
    return node;
  }
  applyResultToRow(node, item, result);
  return node;
}

function setRowStatus(node, text, klass = '') {
  const status = node.querySelector('.row-status');
  status.className = 'row-status' + (klass ? ` ${klass}` : '');
  node.querySelector('.row-status-text').textContent = text;
}

function setRowStatusById(id, text, klass = '') {
  const li = rowsList.querySelector(`li[data-id="${id}"]`);
  if (!li) return;
  // Map klass (used by callers as a shorthand) → CSS data-state. Empty klass
  // means in-flight, which the design styles as 'working'.
  li.dataset.state = klass === 'ok' ? 'ok'
    : klass === 'review' ? 'review'
    : klass === 'error' ? 'error'
    : 'working';
  setRowStatus(li, text, klass);
}

function applyResultToRow(node, item, r) {
  const stateClass = r.status === 'ok' ? 'ok' : r.status === 'error' ? 'error' : 'review';
  node.dataset.state = stateClass;
  const label = r.status === 'ok' ? 'ok'
    : r.status === 'error' ? 'error'
    : `review · ${(r.reasons || []).join(' · ')}`;
  setRowStatus(node, label, stateClass);

  const f = r.fields || {};
  const meta = node.querySelector('.row-meta');
  node.querySelector('.rm-brand').textContent = f.brand || f.vendor || '';
  node.querySelector('.rm-amount').textContent = typeof f.amount === 'number' ? f.amount.toFixed(2) : (f.amount || '');
  node.querySelector('.rm-date').textContent = f.date || '';
  meta.hidden = false;

  const expandBtn = node.querySelector('.row-expand');
  const expandBody = node.querySelector('.row-expand-body');
  expandBtn.hidden = false;
  expandBtn.addEventListener('click', () => {
    const opening = expandBody.hidden;
    expandBody.hidden = !opening;
    expandBtn.setAttribute('aria-expanded', String(opening));
  });

  const processed = node.querySelector('.row-processed');
  if (r.processedUrl) {
    processed.src = r.processedUrl;
    processed.alt = `Processed scan of ${r.file?.name || 'receipt'}`;
  } else {
    processed.remove();
  }

  const dl = node.querySelector('.row-fields');
  const fieldRows = [
    ['vendor',   f.vendor,  false],
    ['brand',    f.brand,   false],
    ['address',  f.address, false],
    ['date',     f.date,    true],
    ['subtotal', fmtNum(f.subtotal), true],
    ['tax',      fmtNum(f.tax),      true],
    ['amount',   fmtNum(f.amount),   true],
    ['currency', f.currency, true],
    ['quality',  f.quality,  false],
  ];
  for (const [k, v, numeric] of fieldRows) {
    if (v == null || v === '') continue;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    if (numeric) dd.className = 'num';
    dl.appendChild(dt); dl.appendChild(dd);
  }

  const slugBase = r.slug || (r.file?.name || '').replace(/\.[^.]+$/, '');
  node.querySelector('.row-slug').textContent = `${slugBase}.jpg`;

  const reprocessBtn = node.querySelector('.row-reprocess');
  reprocessBtn.addEventListener('click', () => reprocessOne(item.id));

  const retryBtn = node.querySelector('.row-retry');
  if (r.status === 'error' || r.status === 'review') {
    retryBtn.hidden = false;
    retryBtn.addEventListener('click', () => reprocessOne(item.id));
  }
}

async function reprocessOne(id) {
  const item = state.queue.find(q => q.id === id);
  if (!item) { alert('Original photo no longer in this session — cannot retry.'); return; }
  if (!state.apiKey) { alert('Please connect first.'); return; }
  state.results = state.results.filter(r => r.id !== id);
  renderRows();
  setRowStatusById(id, 'processing…', '');
  try {
    const result = await processOne(item);
    state.results.push(result);
    renderRows();
  } catch (e) {
    console.error(e);
    state.results.push({ id, file: item.file, status: 'error', reasons: [e.message.slice(0, 80)], fields: {} });
    renderRows();
  }
}
clearQueueBtn.addEventListener('click', () => {
  for (const item of state.queue) URL.revokeObjectURL(item.thumbUrl);
  for (const r of state.results) if (r.processedUrl) URL.revokeObjectURL(r.processedUrl);
  state.queue = [];
  state.results = [];
  renderRows();
});

// ---------- image decoding + downscale ----------
async function fileToCanvas(file) {
  // Using createImageBitmap honors EXIF orientation in modern browsers.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}
function downscaleForApi(srcCanvas, maxEdge = API_MAX_EDGE) {
  const { width, height } = srcCanvas;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale === 1) return srcCanvas;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(srcCanvas, 0, 0, w, h);
  return c;
}
function canvasToJpegBlob(canvas, quality = 0.85) {
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
}
async function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

// ---------- OpenAI call ----------
async function extractFields(apiJpegDataUrl) {
  const base = API_BASE[state.provider] || API_BASE.openai;
  const model = state.provider === 'openrouter' ? MODEL_OPENROUTER : MODEL_OPENAI;
  const headers = {
    'Authorization': `Bearer ${state.apiKey}`,
    'Content-Type': 'application/json',
  };
  // OpenRouter recommends these for proper attribution / app analytics.
  if (state.provider === 'openrouter') {
    headers['HTTP-Referer'] = window.location.origin;
    headers['X-Title'] = 'receipts';
  }
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: EXTRACTION_PROMPT },
            { type: 'image_url', image_url: { url: apiJpegDataUrl, detail: 'high' } },
          ],
        },
      ],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content in response');
  return JSON.parse(content);
}

// ---------- classification ----------
const CRITICAL = ['brand', 'date', 'amount'];
function classifyOutcome(fields, cornersValid) {
  const reasons = [];
  const quality = (fields?.quality || '').toLowerCase();
  if (quality === 'unreadable') reasons.push('unreadable');
  else if (quality === 'poor') reasons.push('quality-poor');
  for (const k of CRITICAL) {
    const v = fields?.[k];
    if (v == null || (typeof v === 'string' && !v.trim())) reasons.push(`missing-${k}`);
  }
  const date = fields?.date;
  if (typeof date === 'string' && date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) reasons.push('bad-date');
  if (!cornersValid) reasons.push('bad-corners');
  return { status: reasons.length ? 'review' : 'ok', reasons };
}
function slugify(s) {
  return (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function buildSlug(fields) {
  const brand = slugify(fields?.brand || fields?.vendor || '');
  const date = fields?.date || '';
  const amount = fields?.amount;
  if (!brand || !/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof amount !== 'number') return null;
  return `${brand}--${date}--${amount.toFixed(2)}`;
}

// ---------- single-file pipeline ----------
async function processOne(item) {
  const srcCanvas = await fileToCanvas(item.file);
  const apiCanvas = downscaleForApi(srcCanvas);
  const apiBlob = await canvasToJpegBlob(apiCanvas, 0.85);
  const apiDataUrl = await blobToDataUrl(apiBlob);

  const fields = await extractFields(apiDataUrl);

  const corners = fields?.corners;
  const cornersValid = validCorners(corners);
  let processedCanvas;
  if (cornersValid) {
    const [srcW, srcH] = [srcCanvas.width, srcCanvas.height];
    const srcPts = corners.map(([x, y]) => [x * srcW, y * srcH]);
    const [w, h] = outputSizeFromCorners(srcPts);
    processedCanvas = warpImage(srcCanvas, srcPts, w, h);
  } else {
    processedCanvas = srcCanvas;
  }
  const processedBlob = await canvasToJpegBlob(processedCanvas, 0.92);

  const { status, reasons } = classifyOutcome(fields, cornersValid);
  const publicFields = { ...fields };
  delete publicFields.corners;

  return {
    id: item.id,
    file: item.file,
    fields: publicFields,
    status,
    reasons,
    processedBlob,
    processedUrl: URL.createObjectURL(processedBlob),
    slug: buildSlug(fields),
  };
}

// ---------- shared: prepare image for API ----------
async function prepareApiBlob(file) {
  const srcCanvas = await fileToCanvas(file);
  const apiCanvas = downscaleForApi(srcCanvas);
  return await canvasToJpegBlob(apiCanvas, 0.85);
}

// ---------- mode switch ----------
function setMode(m) {
  state.mode = m;
  localStorage.setItem(MODE_STORAGE, m);
  modeLiveBtn.setAttribute('aria-selected', String(m === 'live'));
  modeBatchBtn.setAttribute('aria-selected', String(m === 'batch'));
  modeLiveBtn.classList.toggle('is-on', m === 'live');
  modeBatchBtn.classList.toggle('is-on', m === 'batch');
  modeNote.textContent = m === 'live'
    ? 'Each receipt fires its own request and shows up as it finishes. Best when you want to watch them roll in.'
    : 'Submitted to OpenAI\u2019s Batch API. Usually done in a few minutes, and cheaper than fast mode. Bonus: it survives a tab close \u2014 come back here and your batch will be waiting.';
  modeNote.hidden = false;
  runBtn.textContent = m === 'live' ? 'Process now' : 'Submit batch';
  renderRows();
}
modeLiveBtn.addEventListener('click', () => setMode('live'));
modeBatchBtn.addEventListener('click', () => setMode('batch'));
setMode(state.mode);

runBtn.addEventListener('click', () => {
  if (state.mode === 'batch') runBatchSubmission();
  else runLiveProcessing();
});

// ---------- batch flow ----------
let pollInterval = null;

async function runBatchSubmission() {
  if (!state.apiKey) { alert('Please save your OpenAI API key first.'); return; }
  if (!state.queue.length) return;
  runBtn.disabled = true;
  clearQueueBtn.disabled = true;

  const queueSnapshot = state.queue.slice();
  for (const item of queueSnapshot) setRowStatusById(item.id, 'preparing…');

  try {
    const record = await submitBatch({
      queue: queueSnapshot,
      prepareApiBlob,
      extractionPrompt: EXTRACTION_PROMPT,
      model: MODEL_OPENAI,
      apiKey: state.apiKey,
      onProgress: (msg) => {
        for (const item of queueSnapshot) setRowStatusById(item.id, msg.length > 50 ? msg.slice(0, 50) + '…' : msg);
      },
    });
    for (const item of queueSnapshot) URL.revokeObjectURL(item.thumbUrl);
    state.queue = [];
    renderRows();
    await refreshAndRenderBatches();
    startPolling();
    alert(
      `Batch submitted to OpenAI.\n\nID: ${record.batch_id}\n\nBookmark this URL \u2014 your batch sits on OpenAI's servers for ~30 days (their retention, not mine), so you can recover it even if you wipe your browser:\n${PLATFORM_BATCH_URL(record.batch_id)}`
    );
  } catch (e) {
    console.error(e);
    alert(`Submit failed: ${e.message}`);
    for (const item of queueSnapshot) setRowStatusById(item.id, 'submit failed', 'error');
  } finally {
    runBtn.disabled = false;
    clearQueueBtn.disabled = false;
  }
}

async function refreshAndRenderBatches({ poll = false } = {}) {
  const all = await listBatches();
  if (!all.length) { batchesSection.hidden = true; return; }
  // If polling, refresh non-terminal batches' status from the API.
  if (poll && state.apiKey) {
    for (const rec of all) {
      if (!TERMINAL_STATES.has(rec.status_cache)) {
        try { await refreshStatus(rec.batch_id, state.apiKey); } catch (e) { console.warn('poll failed for', rec.batch_id, e); }
      }
    }
  }
  const fresh = await listBatches();
  fresh.sort((a, b) => (b.submitted_at || 0) - (a.submitted_at || 0));
  renderBatchList(fresh);
  batchesSection.hidden = false;
}

function renderBatchList(records) {
  batchList.innerHTML = '';
  for (const rec of records) {
    const status = rec.status_cache || 'unknown';
    const counts = rec.request_counts;
    const total = rec.items?.length ?? counts?.total ?? 0;
    const completed = counts?.completed ?? 0;
    const failed = counts?.failed ?? 0;
    const isComplete = status === 'completed';
    const li = document.createElement('li');
    li.className = 'batch-item';
    li.dataset.batchId = rec.batch_id;
    const statusBadge = `<span class="badge status-${status}">${escapeHtml(status)}</span>`;
    const progress = (counts && total) ? `${completed}/${total} done${failed ? `, ${failed} failed` : ''}` : `${total} receipts`;
    const fetchLabel = rec.fetched ? 'Show results' : (isComplete ? 'Fetch results' : 'Fetch results');
    li.innerHTML = `
      <div class="batch-head">
        <span class="batch-id mono">${escapeHtml(rec.batch_id)}</span>
        ${statusBadge}
      </div>
      <div class="batch-meta">
        ${escapeHtml(progress)} · submitted ${formatRelative(rec.submitted_at)}
      </div>
      <div class="batch-link">
        <a href="${PLATFORM_BATCH_URL(rec.batch_id)}" target="_blank" rel="noopener">${escapeHtml(PLATFORM_BATCH_URL(rec.batch_id))}</a>
        <p class="batch-link-note">Bookmark this — your batch lives on OpenAI for ~30 days. You can recover the JSONL output from there even if your browser data is wiped.</p>
      </div>
      <div class="batch-actions">
        <button data-act="refresh" class="btn btn-ghost">Refresh status</button>
        <button data-act="fetch" class="btn btn-primary" ${(isComplete || rec.fetched) ? '' : 'disabled'}>${fetchLabel}</button>
        <button data-act="delete" class="btn btn-ghost" type="button">Delete</button>
      </div>
    `;
    li.querySelector('[data-act="refresh"]').addEventListener('click', () => onRefreshBatch(rec.batch_id));
    li.querySelector('[data-act="fetch"]').addEventListener('click', () => onFetchBatch(rec.batch_id));
    li.querySelector('[data-act="delete"]').addEventListener('click', () => onDeleteBatch(rec.batch_id));
    batchList.appendChild(li);
  }
}

async function onRefreshBatch(batch_id) {
  if (!state.apiKey) { alert('Please save your OpenAI API key first.'); return; }
  try {
    await refreshStatus(batch_id, state.apiKey);
    await refreshAndRenderBatches();
  } catch (e) {
    alert(`Refresh failed: ${e.message}`);
  }
}

async function onFetchBatch(batch_id) {
  const rec = await getBatchRecord(batch_id);
  if (!rec) return;

  // If we've already fetched and warped, just re-render from IDB.
  if (rec.fetched) {
    state.results = hydrateResults(rec).map(attachProcessedUrl);
    renderRows();
    workSection.scrollIntoView({ behavior: 'smooth' });
    return;
  }

  if (!state.apiKey) { alert('Please save your OpenAI API key first.'); return; }
  try {
    const results = await fetchAndProcess({
      batch_id,
      apiKey: state.apiKey,
      classifyOutcome,
      buildSlug,
      onProgress: (msg) => console.log(msg),
    });
    state.results = results.map(attachProcessedUrl);
    renderRows();
    await refreshAndRenderBatches();
    workSection.scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    alert(`Fetch failed: ${e.message}`);
  }
}

async function onDeleteBatch(batch_id) {
  if (!confirm(`Delete batch ${batch_id} and its source files from this browser?\n\nIt will still exist on OpenAI for ~30 days; you can recover it from ${PLATFORM_BATCH_URL(batch_id)}.`)) return;
  await deleteBatchAndFiles(batch_id);
  await refreshAndRenderBatches();
}

function attachProcessedUrl(r) {
  return {
    ...r,
    processedUrl: r.processedBlob ? URL.createObjectURL(r.processedBlob) : null,
  };
}

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(() => { refreshAndRenderBatches({ poll: true }); }, 30_000);
}

function formatRelative(ts) {
  if (!ts) return 'just now';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

async function runLiveProcessing() {
  if (!state.apiKey) {
    alert('Please paste your OpenAI API key first.');
    return;
  }
  if (!state.queue.length) return;
  runBtn.disabled = true;
  clearQueueBtn.disabled = true;
  for (const item of state.queue) {
    setRowStatusById(item.id, 'processing…');
    try {
      const result = await processOne(item);
      state.results.push(result);
      setRowStatusById(item.id, result.status === 'ok' ? 'ok' : `review: ${result.reasons.join(',')}`, result.status === 'ok' ? 'ok' : 'review');
      renderRows();
    } catch (e) {
      console.error(e);
      setRowStatusById(item.id, `error: ${e.message.slice(0, 40)}`, 'error');
    }
  }
  runBtn.disabled = false;
  clearQueueBtn.disabled = false;
}

downloadAllBtn.addEventListener('click', async () => {
  if (!state.results.length) return;
  const zip = new JSZip();
  for (const r of state.results) {
    const base = r.slug || r.file.name.replace(/\.[^.]+$/, '');
    const dir = zip.folder(base);
    dir.file('processed.jpg', r.processedBlob);
    dir.file('extracted.json', JSON.stringify(r.fields, null, 2));
  }
  const okCsv = buildCsv(state.results, 'ok');
  const reviewCsv = buildCsv(state.results, 'review');
  if (okCsv) zip.file('ok.csv', '\ufeff' + okCsv);
  if (reviewCsv) zip.file('review.csv', '\ufeff' + reviewCsv);
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, 'receipts.zip');
});

// ---------- CSV export ----------
// Two flavors: "ok" for clean bookkeeping rows, "review" adds status/reasons up
// front so you can see at a glance why a row needs human attention. Both are
// sorted ascending by receipt date; rows with an unparseable date sink to the
// bottom (they're the ones you'll want to fix anyway).
const OK_COLUMNS = [
  'date', 'vendor', 'brand',
  'amount', 'tax', 'subtotal', 'currency',
  'city', 'region', 'country', 'address', 'phone',
  'filename', 'slug', 'quality', 'notes',
];
const REVIEW_COLUMNS = [
  'date', 'vendor', 'brand',
  'amount', 'tax', 'subtotal', 'currency',
  'status', 'reasons', 'quality', 'notes',
  'city', 'region', 'country', 'address', 'phone',
  'filename', 'slug',
];

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function rowMap(r) {
  const f = r.fields || {};
  const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : (v ?? ''));
  return {
    filename: r.file?.name || '',
    slug: r.slug || '',
    status: r.status || '',
    reasons: (r.reasons || []).join('; '),
    vendor: f.vendor, brand: f.brand, address: f.address,
    city: f.city, region: f.region, country: f.country, phone: f.phone,
    date: f.date,
    subtotal: fmt(f.subtotal),
    tax: fmt(f.tax),
    amount: fmt(f.amount),
    currency: f.currency,
    quality: f.quality, notes: f.notes,
  };
}
function sortByDate(results) {
  const dateKey = (r) => {
    const d = r.fields?.date;
    return /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : '9999-99-99';
  };
  return results.slice().sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
}
function buildCsv(results, status) {
  const filtered = sortByDate(results.filter(r => r.status === status));
  if (!filtered.length) return null;
  const columns = status === 'ok' ? OK_COLUMNS : REVIEW_COLUMNS;
  const lines = [columns.join(',')];
  for (const r of filtered) {
    const row = rowMap(r);
    lines.push(columns.map(c => csvCell(row[c])).join(','));
  }
  return lines.join('\r\n');
}

// ---------- download helpers ----------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  downloadBlob(blob, filename);
}

// ---------- utils ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function fmtNum(v) {
  if (typeof v !== 'number') return v;
  return v.toFixed(2);
}

// ---------- init ----------
(async () => {
  // 1. If we just landed back from the OpenRouter authorize page, finish the
  //    PKCE handshake before anything else looks at state.apiKey.
  if (isReturningFromOpenRouter()) {
    try {
      const { key } = await completeOpenRouterAuth();
      persistAuth('openrouter', key);
      renderKeyStatus();
    } catch (e) {
      console.warn('OpenRouter callback failed:', e);
      alert(`Sign-in failed: ${e.message}`);
    }
  } else {
    renderKeyStatus();
  }
  // 2. Resume any persisted batches from a previous session.
  try {
    await refreshAndRenderBatches({ poll: !!state.apiKey && state.provider === 'openai' });
    if (state.apiKey && state.provider === 'openai') startPolling();
  } catch (e) {
    console.warn('init batches failed:', e);
  }
})();
