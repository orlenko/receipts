// PoC pipeline: image → (OpenCV) corner detection → perspective warp →
// backend OCR → field extraction. OpenCV.js is lazy-loaded from CDN and cached.

import { extractFields } from './fields.js';

let cvPromise = null;

export function loadOpenCV() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    if (window.cv && window.cv.Mat) { resolve(window.cv); return; }
    const s = document.createElement('script');
    s.src = 'https://docs.opencv.org/4.x/opencv.js';
    s.async = true;
    s.onerror = () => reject(new Error('Failed to load OpenCV.js'));
    s.onload = () => {
      if (window.cv && window.cv.Mat) { resolve(window.cv); return; }
      window.cv.onRuntimeInitialized = () => resolve(window.cv);
    };
    document.head.appendChild(s);
  });
  return cvPromise;
}

// ── image helpers ───────────────────────────────────────────────────

export async function loadBitmap(file) {
  // EXIF orientation is respected so we don't hand a sideways photo to OpenCV.
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

// ── corner detection ────────────────────────────────────────────────
//
// Canny → morphological close → largest-quadrilateral-by-area. Works on
// clean photos; fails on busy backgrounds, curled receipts, partial occlusion.
// Caller deals with null by skipping the warp step and OCR'ing the raw image.

export async function findReceiptCorners(canvas) {
  const cv = await loadOpenCV();
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);
  const closed = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 50, 150);
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imageArea = src.rows * src.cols;
    let bestQuad = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      // Skip tiny contours (<8% of image area); these aren't the receipt edge.
      if (area < imageArea * 0.08) { cnt.delete(); continue; }
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
      if (approx.rows === 4 && area > bestArea) {
        bestQuad = [
          [approx.data32S[0], approx.data32S[1]],
          [approx.data32S[2], approx.data32S[3]],
          [approx.data32S[4], approx.data32S[5]],
          [approx.data32S[6], approx.data32S[7]],
        ];
        bestArea = area;
      }
      approx.delete();
      cnt.delete();
    }

    if (!bestQuad) return null;
    return orderCorners(bestQuad);
  } finally {
    [src, gray, blurred, edges, kernel, closed, contours, hierarchy].forEach((m) => m.delete());
  }
}

// Order four points as TL, TR, BR, BL using sum/diff heuristic.
// This does not figure out WHICH edge of the receipt is "top" semantically —
// classical CV can't know that without reading the text. We accept whichever
// orientation OpenCV finds and let the OCR step cope.
function orderCorners(pts) {
  const sums = pts.map((p) => p[0] + p[1]);
  const diffs = pts.map((p) => p[1] - p[0]);
  const tl = pts[indexOfMin(sums)];
  const br = pts[indexOfMax(sums)];
  const tr = pts[indexOfMin(diffs)];
  const bl = pts[indexOfMax(diffs)];
  return [tl, tr, br, bl];
}

function indexOfMin(arr) { let k = 0; for (let i = 1; i < arr.length; i++) if (arr[i] < arr[k]) k = i; return k; }
function indexOfMax(arr) { let k = 0; for (let i = 1; i < arr.length; i++) if (arr[i] > arr[k]) k = i; return k; }

export async function warpToUpright(canvas, corners) {
  const cv = await loadOpenCV();
  const src = cv.imread(canvas);
  const dstMat = new cv.Mat();
  let srcPts, dstPts, M;
  try {
    const widthA = Math.hypot(corners[2][0] - corners[3][0], corners[2][1] - corners[3][1]);
    const widthB = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]);
    const heightA = Math.hypot(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1]);
    const heightB = Math.hypot(corners[2][0] - corners[1][0], corners[2][1] - corners[1][1]);
    const W = Math.max(50, Math.round(Math.max(widthA, widthB)));
    const H = Math.max(50, Math.round(Math.max(heightA, heightB)));

    srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat());
    dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
    M = cv.getPerspectiveTransform(srcPts, dstPts);
    cv.warpPerspective(src, dstMat, M, new cv.Size(W, H));

    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    cv.imshow(out, dstMat);
    return out;
  } finally {
    [src, dstMat, srcPts, dstPts, M].forEach((m) => m && m.delete && m.delete());
  }
}

// ── the whole pipeline ──────────────────────────────────────────────

export async function runPipeline(file, backend) {
  const t0 = performance.now();
  const bitmap = await loadBitmap(file);
  const rawCanvas = bitmapToCanvas(bitmap);
  const t1 = performance.now();

  const corners = await findReceiptCorners(rawCanvas);
  const t2 = performance.now();

  const processed = corners ? await warpToUpright(rawCanvas, corners) : rawCanvas;
  const t3 = performance.now();

  const ocr = await backend.recognize(processed);
  const t4 = performance.now();

  const fields = extractFields(ocr.text);

  return {
    corners,
    cornersFound: !!corners,
    fields,
    ocrText: ocr.text,
    ocrConfidence: ocr.confidence,
    processedCanvas: processed,
    timings: {
      prep: t1 - t0,
      corners: t2 - t1,
      warp: t3 - t2,
      ocr: t4 - t3,
      total: t4 - t0,
    },
  };
}
