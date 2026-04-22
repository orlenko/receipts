// Tesseract.js backend. English + French language packs (Canadian receipts);
// each adds ~2-3 MB on first init, then cached in the browser's storage.

let scriptPromise = null;
let workerPromise = null;

function ensureScript() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.Tesseract) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load tesseract.js'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    await ensureScript();
    // eng + fra gives us English receipts + Québec/French-Canadian receipts.
    return window.Tesseract.createWorker(['eng', 'fra']);
  })();
  return workerPromise;
}

export async function recognize(canvas) {
  const worker = await getWorker();
  const res = await worker.recognize(canvas);
  return {
    text: res.data.text,
    confidence: (res.data.confidence || 0) / 100,
  };
}

export const name = 'tesseract';
