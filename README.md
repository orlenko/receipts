# receipts

Browser-only tool for batch-processing photos of paper receipts. Upload a pile of JPG/PNG photos, hit Process, and get back upright, cropped scans plus structured fields (vendor, amount, tax, date, etc.) as a downloadable ZIP.

Your OpenAI API key and images never leave your browser except to call `api.openai.com` directly. No server, no signup, no tracking beyond privacy-first page analytics.

- **Cost**: ~$0.01 per receipt at OpenAI `gpt-5.4` vision pricing. Typical SaaS OCR services charge $0.05–$0.30 per receipt.
- **Quality**: handles sideways photos, cluttered backgrounds, and crumpled receipts reasonably well.

## Run locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static HTTP server works (Node: `npx serve`; Go: `gosh`). The app is a single `index.html` + `app.js` + `warp.js` + `styles.css` — no build step.

## How it works

1. Each receipt photo is decoded in the browser and downscaled to 1568 px on the long edge.
2. The image is sent to OpenAI's vision model with a prompt asking for the receipt's four corners (in reading order) **and** the structured fields, all in one call.
3. The full-resolution original is then warped locally using those corners, producing an upright, cropped image — all in pure JavaScript via a 3×3 homography.
4. Each receipt shows up with a preview, its extracted fields, and per-file download buttons. Or hit "Download all as ZIP" to get one folder per receipt, named `<brand>--<YYYY-MM-DD>--<amount>/`.

Low-confidence extractions are flagged inline with a reason (`quality-poor`, `missing-amount`, `bad-corners`, etc.) so you know which receipts need a human second look.

## Status

MVP: live mode (one request per receipt, immediate results). Batch mode (50% cheaper, up to 24h SLA using OpenAI's Batch API) is planned.

## License

MIT.
