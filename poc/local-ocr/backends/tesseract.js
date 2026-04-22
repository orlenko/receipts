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

let onLog = null;
function logStep(msg) { if (onLog) onLog(msg); }

async function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    logStep('tesseract: fetching tesseract.js (~2 MB)…');
    await ensureScript();
    logStep('tesseract: creating worker (downloads eng + fra language data, ~7 MB)…');
    // Tesseract fires progress messages several times per second during init
    // and recognize. Route only status transitions + 20% progress buckets to
    // the UI; pushing every tick blew up the log pane and locked the main
    // thread. Everything else still goes to console.debug for inspection.
    let lastStatus = null;
    let lastBucket = -1;
    return window.Tesseract.createWorker(['eng', 'fra'], 1, {
      logger: (m) => {
        if (!m || !m.status) return;
        const pct = typeof m.progress === 'number' ? Math.round(m.progress * 100) : -1;
        const bucket = pct >= 0 ? Math.floor(pct / 20) : -1;
        if (m.status !== lastStatus || (bucket > lastBucket && bucket >= 0)) {
          logStep(`tesseract: ${m.status}${pct >= 0 ? ` ${pct}%` : ''}`);
          lastStatus = m.status;
          lastBucket = bucket;
        }
      },
    });
  })();
  return workerPromise;
}

// Invoked by the harness before the iteration loop so the heavy downloads
// and worker init happen up front, with visible progress, instead of
// stalling the first receipt.
export async function preload(logFn) {
  onLog = logFn || null;
  try {
    await getWorker();
  } finally {
    onLog = null;
  }
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
