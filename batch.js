// receipts — OpenAI Batch API client + result post-processing.
// Submit: builds JSONL, uploads via /v1/files (purpose=batch), creates batch.
// Poll:   GET /v1/batches/{id}
// Fetch:  downloads output JSONL, warps original photos using returned corners.
//
// All persistence goes through ./db.js so batches survive a tab close.

import { putFile, getFile, putBatch, getBatchRecord } from './db.js';
import { warpImage, outputSizeFromCorners, validCorners } from './warp.js';

const API = 'https://api.openai.com/v1';
const ENDPOINT = '/v1/chat/completions';
const COMPLETION_WINDOW = '24h';

// Statuses returned by the OpenAI Batch API.
export const TERMINAL_STATES = new Set(['completed', 'failed', 'expired', 'cancelled']);

// ---------- raw API helpers ----------
async function apiFetch(path, apiKey, init = {}) {
  const headers = { 'Authorization': `Bearer ${apiKey}`, ...(init.headers || {}) };
  const resp = await fetch(`${API}${path}`, { ...init, headers });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI ${resp.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return resp;
}

async function uploadJsonl(jsonlText, apiKey) {
  const fd = new FormData();
  fd.append('purpose', 'batch');
  fd.append('file', new Blob([jsonlText], { type: 'application/jsonl' }), 'batch.jsonl');
  const resp = await apiFetch('/files', apiKey, { method: 'POST', body: fd });
  return resp.json(); // { id, ... }
}

async function createBatch(input_file_id, apiKey) {
  const resp = await apiFetch('/batches', apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input_file_id,
      endpoint: ENDPOINT,
      completion_window: COMPLETION_WINDOW,
    }),
  });
  return resp.json(); // { id, status, ... }
}

export async function getBatch(batch_id, apiKey) {
  const resp = await apiFetch(`/batches/${batch_id}`, apiKey);
  return resp.json();
}

async function downloadFileContent(file_id, apiKey) {
  const resp = await apiFetch(`/files/${file_id}/content`, apiKey);
  return resp.text();
}

// ---------- submit ----------
// queue: [{ id, file: File }]
// prepareApiBlob(file) -> Blob (downscaled JPEG ready for the API)
// extractionPrompt: string
// model: string
export async function submitBatch({ queue, prepareApiBlob, extractionPrompt, model, apiKey, onProgress }) {
  if (!queue?.length) throw new Error('Queue is empty');

  const items = [];
  const jsonlLines = [];
  let i = 0;
  for (const q of queue) {
    i += 1;
    onProgress?.(`Preparing ${i}/${queue.length}: ${q.file.name}`);
    const apiBlob = await prepareApiBlob(q.file);
    const dataUrl = await blobToDataUrl(apiBlob);
    const file_id = crypto.randomUUID();
    await putFile(file_id, q.file, q.file.name, q.file.type);
    const custom_id = `r${String(i).padStart(5, '0')}-${file_id.slice(0, 8)}`;
    jsonlLines.push(JSON.stringify({
      custom_id,
      method: 'POST',
      url: ENDPOINT,
      body: {
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: extractionPrompt },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        }],
      },
    }));
    items.push({ custom_id, file_id, file_name: q.file.name, file_type: q.file.type });
  }

  onProgress?.(`Uploading batch input (${items.length} requests)…`);
  const uploaded = await uploadJsonl(jsonlLines.join('\n'), apiKey);

  onProgress?.('Creating batch…');
  const batch = await createBatch(uploaded.id, apiKey);

  const record = {
    batch_id: batch.id,
    submitted_at: Date.now(),
    model,
    input_file_id: uploaded.id,
    items,
    status_cache: batch.status,
    request_counts: batch.request_counts || null,
    output_file_id: batch.output_file_id || null,
    error_file_id: batch.error_file_id || null,
    fetched: false,
    processed_results: null, // populated after fetch
  };
  await putBatch(record);
  return record;
}

// ---------- refresh status (cheap; one API call) ----------
export async function refreshStatus(batch_id, apiKey) {
  const remote = await getBatch(batch_id, apiKey);
  const rec = await getBatchRecord(batch_id);
  if (!rec) return remote;
  rec.status_cache = remote.status;
  rec.request_counts = remote.request_counts || null;
  rec.output_file_id = remote.output_file_id || rec.output_file_id;
  rec.error_file_id = remote.error_file_id || rec.error_file_id;
  await putBatch(rec);
  return remote;
}

// ---------- fetch + warp ----------
// Returns array of result objects matching the live-mode shape:
//   { custom_id, file: File-like {name, type}, fields, status, reasons,
//     processedBlob, slug }
// Sets fetched=true and processed_results on the IDB record so subsequent
// page loads can render without re-warping.
export async function fetchAndProcess({ batch_id, apiKey, onProgress, classifyOutcome, buildSlug }) {
  const remote = await refreshStatus(batch_id, apiKey);
  if (remote.status !== 'completed') {
    throw new Error(`Batch is "${remote.status}" — not completed yet`);
  }
  if (!remote.output_file_id) {
    throw new Error('Batch is completed but has no output_file_id');
  }

  const rec = await getBatchRecord(batch_id);
  if (!rec) throw new Error('No local manifest for this batch');

  onProgress?.('Downloading output JSONL…');
  const jsonlText = await downloadFileContent(remote.output_file_id, apiKey);

  const lines = jsonlText.split('\n').filter(Boolean);
  const cidToItem = new Map(rec.items.map(it => [it.custom_id, it]));
  const results = [];
  let i = 0;
  for (const line of lines) {
    i += 1;
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { continue; }

    const cid = parsed.custom_id;
    const item = cidToItem.get(cid);
    onProgress?.(`Processing ${i}/${lines.length}: ${item?.file_name || cid}`);

    if (parsed.error || parsed.response?.status_code !== 200) {
      results.push({
        custom_id: cid,
        file: { name: item?.file_name || cid, type: item?.file_type || 'image/jpeg' },
        fields: {},
        status: 'review',
        reasons: ['api-error'],
        processedBlob: null,
        slug: null,
        error: parsed.error || parsed.response,
      });
      continue;
    }

    let fields;
    try {
      fields = JSON.parse(parsed.response.body.choices[0].message.content);
    } catch (e) {
      results.push({
        custom_id: cid,
        file: { name: item?.file_name || cid, type: item?.file_type || 'image/jpeg' },
        fields: {},
        status: 'review',
        reasons: ['parse-error'],
        processedBlob: null,
        slug: null,
        error: String(e),
      });
      continue;
    }

    if (!item) {
      results.push({
        custom_id: cid,
        file: { name: cid, type: 'image/jpeg' },
        fields,
        status: 'review',
        reasons: ['source-missing'],
        processedBlob: null,
        slug: null,
      });
      continue;
    }

    // Fetch the original blob and warp.
    const stored = await getFile(item.file_id);
    const corners = fields?.corners;
    const cornersValid = validCorners(corners);
    let processedBlob = null;
    if (stored?.blob) {
      try {
        const srcCanvas = await blobToCanvas(stored.blob);
        let processedCanvas;
        if (cornersValid) {
          const srcPts = corners.map(([x, y]) => [x * srcCanvas.width, y * srcCanvas.height]);
          const [w, h] = outputSizeFromCorners(srcPts);
          processedCanvas = warpImage(srcCanvas, srcPts, w, h);
        } else {
          processedCanvas = srcCanvas;
        }
        processedBlob = await canvasToJpegBlob(processedCanvas, 0.92);
      } catch (e) {
        console.error(`warp failed for ${cid}:`, e);
      }
    }

    const { status, reasons } = classifyOutcome(fields, cornersValid);
    const publicFields = { ...fields };
    delete publicFields.corners;

    results.push({
      custom_id: cid,
      file: { name: item.file_name, type: item.file_type },
      fields: publicFields,
      status,
      reasons,
      processedBlob,
      slug: buildSlug(fields),
    });
  }

  // Persist everything we can; processed blobs as Blob (IDB stores them fine).
  rec.fetched = true;
  rec.fetched_at = Date.now();
  rec.processed_results = results.map(r => ({
    custom_id: r.custom_id,
    file_name: r.file.name,
    file_type: r.file.type,
    fields: r.fields,
    status: r.status,
    reasons: r.reasons,
    processedBlob: r.processedBlob,
    slug: r.slug,
  }));
  await putBatch(rec);

  return results;
}

// Re-hydrate previously fetched results from IDB without any API call.
export function hydrateResults(rec) {
  if (!rec?.processed_results) return null;
  return rec.processed_results.map(r => ({
    custom_id: r.custom_id,
    file: { name: r.file_name, type: r.file_type },
    fields: r.fields,
    status: r.status,
    reasons: r.reasons,
    processedBlob: r.processedBlob,
    slug: r.slug,
  }));
}

// ---------- helpers ----------
function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

async function blobToCanvas(blob) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  c.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return c;
}

function canvasToJpegBlob(canvas, quality = 0.92) {
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
}
