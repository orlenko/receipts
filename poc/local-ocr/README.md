# Local OCR PoC — findings

Exploratory branch, **not merged to main**. Kept as a reference artifact; the branch name is `feat/local-ocr-poc`.

## The question

Can we replicate OpenAI's receipt-extraction pipeline entirely in the browser, so that a user could process receipts without ever talking to a third-party API?

## What we tried

A comparison harness at `poc/local-ocr/` that pairs each subdir of `sample-data/processed/` (per-receipt `processed.jpg` + `extracted.json` from the OpenAI run) and diffs a local pipeline's extracted fields against the OpenAI ground truth. Originally:

1. **OpenCV.js** for corner detection + perspective warp (Canny → contour → `getPerspectiveTransform`)
2. **Tesseract.js** for OCR (English + French language packs)
3. **Regex + heuristics** for field extraction (brand, date, amount, tax, currency)
4. A second **PaddleOCR web** backend to compare against Tesseract

## What actually happened

**OpenCV.js locked the main thread.** The 9 MB WASM module blocks during init and again on every call (`findContours`, `warpPerspective`). Chrome's tab ended up unresponsive for an hour without producing any output. Moving OpenCV into a Web Worker would fix it but is a significant rewrite (transferable ImageBitmap, worker-owned OpenCV context, etc.). Pulled OpenCV out; pointed the harness at the *already-warped* `processed.jpg` files instead so we could isolate the OCR + extraction question.

**PaddleOCR via CDN was a yak-shaving tunnel.** The package expects a bundler environment that injects emscripten/WASM loader globals. esm.sh's shim got partway (wrong package name → wrong version → wrong input type → node polyfill smoke → `Module is not defined`). Each fix surfaced a new blocker of the same class. Concluded the browser-packaging story for PaddleJS isn't reliable enough to pursue further for this PoC.

## Empirical results (Tesseract.js, n=10)

Against OpenAI ground-truth:

| Field       | Local accuracy | Notes                                                                                              |
| ----------- | -------------- | -------------------------------------------------------------------------------------------------- |
| Brand       | 50%            | Often grabs the top-of-receipt slogan or store number ("WHOLESALE", "CANADIAN TIRE 600", "1 RR")   |
| Date        | 60%            | Regex handles most formats; misses are dates Tesseract didn't read at all                          |
| Amount ±1¢  | 50%            | Fallback often picks subtotal / item line / credit-card amount instead of the total                |
| Tax  ±1¢    | 30%            | Worst failure: one row extracted the **total** as tax (HST label followed by the wrong number)     |
| OCR conf.   | ~75% avg       | Tesseract itself is reading text competently                                                       |

**The ceiling.** OCR isn't the bottleneck — **semantic field extraction is**. Regex + heuristics can't disambiguate "50.83 on a line labelled TOTAL" from "50.83 on a line labelled VISA" from "50.83 on a line labelled HST 13%". This is exactly what LLMs uniquely solve and why classical pipelines plateaued around 2015-2020.

## Conclusion

Local classical OCR (any engine — Tesseract, Paddle, TrOCR) gets you 30–60% per-field accuracy even on a perfect pre-warped input. Not a practical replacement for the LLM-based pipeline. The privacy pitch that this experiment was meant to serve is better delivered by the existing "clone the repo, `python3 -m http.server`, audit the JS yourself" escape hatch.

## Where the real local-LLM option lives (not here)

If someone wants to revisit this, the interesting paths are:

- **Small in-browser LLM for extraction, not OCR.** Keep Tesseract for pixel → text; feed the text to a quantized Flan-T5-small (~80 MB) or a small Phi via Transformers.js / WebLLM. The semantic part is where the accuracy gain lives. Plausibly 80–90% per-field.
- **Self-hosted open-source VLM.** Qwen2.5-VL-7B, InternVL-2, or LLaVA-OneVision on a 12–24 GB consumer GPU. Within ~5–10% of GPT-4o-vision on printed receipts; zero per-request cost; completely different deployment model from a static page.
- **Commercial receipt-specialized APIs.** Veryfi / Mindee / Taggun / Rossum / Base64. Roughly $0.01–$0.05 per receipt (same order as OpenAI Batch). Outperform general-purpose VLMs a few points on clean receipts and meaningfully more on edge cases.

## How to run the PoC again

```bash
python3 -m http.server 8000
# open http://localhost:8000/poc/local-ocr/
```

1. Pick `sample-data/processed/` for the processed-folder input (it's in `.gitignore`; keep your own copy local).
2. Select **Tesseract.js** as the backend.
3. Set **Limit** to 10 or so.
4. Click **Run**.

First run downloads Tesseract + English and French language packs (~7 MB, then cached). Per-receipt time ~2–3 s on a decent laptop.

The **PaddleOCR web** radio button is still in the UI but the wrapper it points at doesn't initialize — left there as a reminder of the CDN-packaging landmine, not as a working option.

## Files in this PoC

| File                        | Role                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `index.html`                | standalone dev-tool UI; not linked from the main app                    |
| `poc.js`                    | orchestration — folder pickers, work loop, running stats, table render  |
| `pipeline.js`               | image load → canvas → OCR backend → field extraction                    |
| `fields.js`                 | regex heuristics + per-field match/partial/miss comparators             |
| `backends/tesseract.js`     | Tesseract.js worker with eng + fra, status-bucketed logger              |
| `backends/paddle.js`        | PaddleOCR wrapper; fails to init — see note above                       |
