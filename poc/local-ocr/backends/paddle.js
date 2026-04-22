// PaddleOCR web backend via @paddlejs-models/ocr (the original PaddlePaddle
// one, not the DataVizU fork @paddle-js-models/ocr). The package uses
// PaddleJS's WebGL backend for inference; its init() fetches the det + rec
// models (~6-10 MB) from a Baidu CDN on first call.
//
// Input API: the package's recognize() takes an HTMLImageElement, not a
// canvas — so we round-trip canvas → Blob → object URL → Image. The
// conversion is cheap (~1 ms); the OCR call dominates.

let modulePromise = null;

async function ensureModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const url = 'https://esm.sh/@paddlejs-models/ocr@1.2.4';
    let mod;
    try {
      mod = await import(/* @vite-ignore */ url);
    } catch (err) {
      throw new Error(`Paddle OCR module failed to load from ${url}: ${err.message}`);
    }
    try {
      await mod.init();
    } catch (err) {
      throw new Error(`Paddle OCR init() failed (probably model download): ${err.message}`);
    }
    return mod;
  })();
  return modulePromise;
}

// Convert a canvas to an HTMLImageElement. The Paddle OCR wrapper reads
// `img.width`/`img.height` and draws it to an internal canvas, so it needs
// a real Image, not our OffscreenCanvas-in-disguise.
async function canvasToImage(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error('canvas.toBlob returned null');
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image decode failed'));
      el.src = url;
    });
    return { img, url };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

export async function preload(logFn) {
  if (logFn) logFn('paddle: fetching module from esm.sh (@paddlejs-models/ocr@1.2.4)…');
  await ensureModule();
  if (logFn) logFn('paddle: ready.');
}

export async function recognize(canvas) {
  const mod = await ensureModule();
  const { img, url } = await canvasToImage(canvas);
  try {
    const res = await mod.recognize(img);
    // res.text is an array of text strings in reading order-ish.
    const textLines = Array.isArray(res?.text) ? res.text : (res?.text ? [String(res.text)] : []);
    const text = textLines.join('\n');
    return { text, confidence: text.length ? 0.75 : 0 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const name = 'paddle';
