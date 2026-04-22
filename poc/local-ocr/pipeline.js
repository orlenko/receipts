// PoC pipeline: JPEG file → canvas → OCR backend → field extraction.
// No corner detection, no warp — we're OCR'ing pre-warped images from
// sample-data/processed/ to isolate the "how good is classical OCR alone"
// question from the "can we do corner detection in the browser" question.
// (Answer to the latter turned out to be: not with OpenCV.js on main thread.)

import { extractFields } from './fields.js';

export async function loadBitmap(file) {
  // Respect EXIF orientation so we don't hand a sideways photo to Tesseract.
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

export function bitmapToCanvas(bitmap, maxEdge = 1600) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

// Browsers don't GC the backing pixel buffer while a canvas element still
// has non-zero dimensions. Zeroing them is the documented way to release it.
function clearCanvas(c) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

// Tiny JPEG Blob for the results table, generated BEFORE we release the
// full-size canvas so the DOM only holds ~2 KB per row instead of MBs.
async function toThumbBlob(canvas, maxEdge = 96) {
  const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(canvas, 0, 0, w, h);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.75));
}

export async function runPipeline(file, backend) {
  const t0 = performance.now();
  const bitmap = await loadBitmap(file);
  const canvas = bitmapToCanvas(bitmap);
  bitmap.close();
  const t1 = performance.now();

  const ocr = await backend.recognize(canvas);
  const t2 = performance.now();

  const thumbBlob = await toThumbBlob(canvas, 96);
  clearCanvas(canvas);
  const t3 = performance.now();

  const fields = extractFields(ocr.text);

  return {
    fields,
    ocrText: ocr.text,
    ocrConfidence: ocr.confidence,
    thumbBlob,
    timings: {
      prep: t1 - t0,
      ocr: t2 - t1,
      thumb: t3 - t2,
      total: t3 - t0,
    },
  };
}
