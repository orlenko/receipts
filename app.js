// receipts — browser orchestration
// BYO OpenAI API key; images + key stay local. Calls api.openai.com directly.

import { warpImage, outputSizeFromCorners, validCorners } from './warp.js';

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

const MODEL = 'gpt-5.4';
const API_MAX_EDGE = 1568;
const KEY_STORAGE = 'receipts.openai_key';

// ---------- state ----------
const state = {
  apiKey: localStorage.getItem(KEY_STORAGE) || '',
  queue: [], // [{id, file, thumbUrl}]
  results: [], // [{id, file, fields, status, reasons, processedBlob, processedUrl}]
};

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const keyInput = $('api-key');
const keyStatus = $('key-status');
const saveKeyBtn = $('save-key');
const clearKeyBtn = $('clear-key');

const dropZone = $('drop-zone');
const fileInput = $('file-input');

const queueSection = $('queue-section');
const queueSummary = $('queue-summary');
const queueList = $('queue-list');
const processBtn = $('process-btn');
const clearQueueBtn = $('clear-queue-btn');

const resultsSection = $('results-section');
const resultsList = $('results-list');
const downloadAllBtn = $('download-all-btn');

// ---------- API key ----------
function renderKeyStatus() {
  if (state.apiKey) {
    keyStatus.textContent = `Key set (ends in …${state.apiKey.slice(-4)}).`;
    keyInput.value = '';
  } else {
    keyStatus.textContent = 'No key set. Paste one above.';
  }
}
saveKeyBtn.addEventListener('click', () => {
  const v = keyInput.value.trim();
  if (!v) return;
  state.apiKey = v;
  localStorage.setItem(KEY_STORAGE, v);
  renderKeyStatus();
});
clearKeyBtn.addEventListener('click', () => {
  state.apiKey = '';
  localStorage.removeItem(KEY_STORAGE);
  renderKeyStatus();
});
renderKeyStatus();

// ---------- drop zone ----------
['dragenter', 'dragover'].forEach(evt => {
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('dragover'); });
});
['dragleave', 'drop'].forEach(evt => {
  dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('dragover'); });
});
dropZone.addEventListener('drop', e => addFiles(e.dataTransfer.files));
fileInput.addEventListener('change', e => addFiles(e.target.files));

function addFiles(fileList) {
  const files = Array.from(fileList).filter(f => /^image\/(jpeg|png)$/.test(f.type));
  if (!files.length) return;
  for (const f of files) {
    const id = crypto.randomUUID();
    const thumbUrl = URL.createObjectURL(f);
    state.queue.push({ id, file: f, thumbUrl });
  }
  renderQueue();
}
function renderQueue() {
  if (!state.queue.length) {
    queueSection.hidden = true;
    return;
  }
  queueSection.hidden = false;
  queueSummary.textContent = `${state.queue.length} file${state.queue.length === 1 ? '' : 's'} ready.`;
  queueList.innerHTML = '';
  for (const item of state.queue) {
    const li = document.createElement('li');
    li.dataset.id = item.id;
    li.innerHTML = `
      <img class="thumb" src="${item.thumbUrl}" alt="" />
      <span class="name">${escapeHtml(item.file.name)}</span>
      <span class="status">queued</span>
    `;
    queueList.appendChild(li);
  }
}
clearQueueBtn.addEventListener('click', () => {
  for (const item of state.queue) URL.revokeObjectURL(item.thumbUrl);
  state.queue = [];
  renderQueue();
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
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${state.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
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

function setQueueStatus(id, text, klass = '') {
  const li = queueList.querySelector(`li[data-id="${id}"] .status`);
  if (!li) return;
  li.textContent = text;
  li.className = 'status' + (klass ? ` ${klass}` : '');
}

processBtn.addEventListener('click', async () => {
  if (!state.apiKey) {
    alert('Please paste your OpenAI API key first.');
    return;
  }
  if (!state.queue.length) return;
  processBtn.disabled = true;
  clearQueueBtn.disabled = true;
  for (const item of state.queue) {
    setQueueStatus(item.id, 'processing…');
    try {
      const result = await processOne(item);
      state.results.push(result);
      setQueueStatus(item.id, result.status === 'ok' ? 'ok' : `review: ${result.reasons.join(',')}`, result.status === 'ok' ? 'ok' : 'review');
      renderResults();
    } catch (e) {
      console.error(e);
      setQueueStatus(item.id, `error: ${e.message.slice(0, 40)}`, 'error');
    }
  }
  processBtn.disabled = false;
  clearQueueBtn.disabled = false;
});

// ---------- results ----------
function renderResults() {
  if (!state.results.length) {
    resultsSection.hidden = true;
    return;
  }
  resultsSection.hidden = false;
  resultsList.innerHTML = '';
  for (const r of state.results) {
    const card = document.createElement('div');
    card.className = 'result-card';
    const badge = r.status === 'ok' ? `<span class="badge ok">ok</span>` :
      `<span class="badge review">review: ${escapeHtml(r.reasons.join(', '))}</span>`;
    const dl = document.createElement('dl');
    const rows = [
      ['vendor',   r.fields.vendor],
      ['brand',    r.fields.brand],
      ['address',  r.fields.address],
      ['date',     r.fields.date],
      ['subtotal', fmtNum(r.fields.subtotal)],
      ['tax',      fmtNum(r.fields.tax)],
      ['amount',   fmtNum(r.fields.amount)],
      ['currency', r.fields.currency],
      ['quality',  r.fields.quality],
    ];
    for (const [k, v] of rows) {
      if (v == null || v === '') continue;
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.style.margin = '0'; dd.textContent = String(v);
      dl.appendChild(dt); dl.appendChild(dd);
    }
    card.innerHTML = `
      <img class="processed" src="${r.processedUrl}" alt="processed receipt" />
      <div class="fields">
        <div><strong>${escapeHtml(r.file.name)}</strong> ${badge}</div>
        <div class="actions">
          <button data-act="dl-jpg">Download JPG</button>
          <button data-act="dl-json" class="secondary">Download JSON</button>
        </div>
      </div>
    `;
    card.querySelector('.fields').appendChild(dl);
    card.querySelector('[data-act="dl-jpg"]').addEventListener('click', () => downloadBlob(r.processedBlob, `${r.slug || r.file.name.replace(/\.[^.]+$/, '')}.jpg`));
    card.querySelector('[data-act="dl-json"]').addEventListener('click', () => downloadJson(r.fields, `${r.slug || r.file.name.replace(/\.[^.]+$/, '')}.json`));
    resultsList.appendChild(card);
  }
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
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, 'receipts.zip');
});

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
