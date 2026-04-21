# receipts

A small browser-only tool for turning a pile of receipt photos into upright, cropped scans plus a tidy spreadsheet. Built so I could move faster through my own tax-season bookkeeping; sharing because someone else might find it useful.

**Live at:** [receipts.clickable.one](https://receipts.clickable.one)

This is a static page. There's no server, no signup, no account, nothing to pay me. You bring your own [OpenAI API key](https://platform.openai.com/api-keys); your images and key stay in your browser and talk to OpenAI directly. Not affiliated with OpenAI.

## What it does

- Drag in a stack of JPG/PNG receipts (any orientation, cluttered backgrounds are fine).
- Each photo is sent to an OpenAI vision model in a single call that returns both the receipt's four corners (in reading order) **and** the structured fields. The full-resolution original is then warped locally in pure JavaScript via a 3×3 homography — produces an upright, cropped scan without any server-side image processing.
- Two modes:
  - **Live** — one API call per receipt, results stream in over seconds. Full price (~$0.01/receipt at current OpenAI rates).
  - **Batch** — built around OpenAI's Batch API (~50% off, finishes in minutes). The submission, the source photos, and the eventual results are saved to your browser's IndexedDB so you can close the tab and come back; the OpenAI batch ID is also a real URL on `platform.openai.com` valid for ~30 days, so your data is recoverable even if you wipe the browser.
- Output: per-receipt folder (`<brand>--<YYYY-MM-DD>--<amount>/`) with the cleaned `processed.jpg` and `extracted.json`, plus two CSVs:
  - `ok.csv` — clean rows, sorted by date, ready to drop into a bookkeeping template.
  - `review.csv` — rows with missing/ambiguous fields, with `status` and `reasons` up front.
- Low-confidence extractions are inline-flagged (`quality-poor`, `missing-amount`, `bad-corners`, `unreadable`, …) so you know which receipts need a second look before they hit the books.

## Privacy

- Your OpenAI key is stored in `localStorage` of your browser, never sent anywhere except OpenAI as an `Authorization` header.
- Receipt images are downscaled to 1568 px on the long edge and sent to OpenAI for OCR. The model's response is parsed locally and used to crop and warp the image in-browser. Nothing is sent to any other server.
- For traffic stats the site uses Cloudflare's edge-side Analytics Engine via a Pages Function: anonymous hit counter, no cookies, no client-side JS tracker, no raw IP retained — country/city/region are derived at the CF edge from the inbound request and stored without the address itself.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Any static HTTP server works (`npx serve`, `gosh`, etc.). The app is plain HTML + ESM JavaScript + one CSS file + JSZip from CDN — no framework, no build step.

| File | Role |
|------|------|
| `index.html`, `styles.css` | UI |
| `app.js` | orchestration: state, key/queue/results, mode switch, downloads |
| `warp.js` | pure-JS perspective transform (homography solver + bilinear sampler) |
| `batch.js` | OpenAI Batch API client + post-fetch warp + result hydration |
| `db.js` | IndexedDB wrapper (persists batches and source-photo blobs) |
| `functions/_middleware.ts` | CF Pages Function: anonymous hit counter (only used in production) |

## Deploying your own copy

See [HOW_TO_DEPLOY.md](./HOW_TO_DEPLOY.md). Targets Cloudflare Pages: fork the repo, connect it in the CF dashboard, configure the analytics binding, point a domain at it. Updates after the initial setup are just `git push`.

## Status

The full pipeline (live + batch + persistence + recovery) is shipped. Things still on the wishlist: HEIC support without a manual convert step (probably via `libheif-js`), a tiny in-page chart for the Analytics Engine stats so I don't have to open the CF dashboard.

## License

MIT — see [LICENSE](./LICENSE).
