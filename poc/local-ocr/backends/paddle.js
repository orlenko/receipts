// PaddleOCR web backend (@paddle-js-models/ocr). Models are fetched on first
// init(); the package uses WebGL under the hood for inference.
//
// Caveats: this library has historically been finicky in browser environments —
// the CDN ES build can fail to resolve transitive Paddle.js deps. If load fails
// for you, the thrown error includes the URL to help debug; in the meantime,
// fall back to the Tesseract backend.

let modulePromise = null;

async function ensureModule() {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    // esm.sh bundles npm packages as browser-usable ES modules and resolves deps.
    const url = 'https://esm.sh/@paddle-js-models/ocr@1.1.3';
    let mod;
    try {
      mod = await import(/* @vite-ignore */ url);
    } catch (err) {
      throw new Error(`Paddle OCR module failed to load from ${url}: ${err.message}`);
    }
    // init() downloads the det + rec models (~6-10 MB); may take several seconds on first call.
    try {
      await mod.init();
    } catch (err) {
      throw new Error(`Paddle OCR models failed to initialize: ${err.message}`);
    }
    return mod;
  })();
  return modulePromise;
}

export async function recognize(canvas) {
  const mod = await ensureModule();
  // The recognize() API accepts HTMLCanvasElement / HTMLImageElement / ImageData.
  const res = await mod.recognize(canvas);
  // res.text: array of detected strings roughly in reading order.
  const textLines = Array.isArray(res?.text) ? res.text : (res?.text ? [String(res.text)] : []);
  const text = textLines.join('\n');
  // No reliable per-detection confidence surfaced by this wrapper; leave as 0.6
  // when we got something, 0 when we didn't.
  return { text, confidence: text.length ? 0.6 : 0 };
}

export const name = 'paddle';
