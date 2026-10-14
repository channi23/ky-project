# KY

KY turns photos of Indian paper receipts (printed or handwritten) into Excel files.

- Upload from desktop or phone, with camera capture, drag and drop, or paste.
- Reads dates, item names, quantities, rates, amounts, GST (CGST / SGST / IGST), GSTIN and totals.
- Shows everything in an editable table so you can fix mistakes before you download.
- Exports a formatted `.xlsx` with an **Items** sheet and a **Summary** sheet (GST and total checks).
- **Share KY** button uses the phone or desktop share menu, or copies the link.

## Privacy

- No database, no login, no server storage.
- By default, receipt photos are read **inside your browser** with Tesseract.js (English + Hindi). Photos and Excel files never leave your device.
- On first use the browser downloads the OCR engine and language data (about 8 MB in total) from the public jsDelivr CDN, then caches it. Only these files are requested, never your photo.
- Reloading or closing the page erases everything. "Clear all" does it on demand.
- *Optional* **Enhanced handwriting mode** sends the photo to a small backend you host. It is off unless you set it up and is off by default for every user. See [Optional backend](#optional-enhanced-handwriting-backend).

## Run it locally

Requires Node.js 20 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # parser and Excel tests
npm run build      # type-check and create dist/
npm run preview    # serve dist/ locally
```

Phone testing on the same Wi-Fi: `npm run dev -- --host`, then open the printed network address. Camera capture needs HTTPS on most phones, which GitHub Pages provides.

## Deploy to GitHub Pages

1. Create a new GitHub repository (any name) and push this project to the `main` branch:
   ```bash
   git init
   git add .
   git commit -m "KY"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git push -u origin main
   ```
2. In the repository open **Settings → Pages**, and set **Source** to **GitHub Actions**.
3. The workflow in `.github/workflows/deploy.yml` runs on every push to `main`. It installs, runs the tests, builds, and deploys. When it finishes, your site is at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

The Vite `base` is `./` (relative), so the site works under any repository name or custom domain with no configuration. You can also run the workflow by hand from the **Actions** tab.

## Optional: enhanced handwriting backend

Browser OCR is good on printed bills and weaker on handwriting. For handwriting, KY can send a photo to a small stateless service that uses an AI vision model. **The site works fully without it.**

What it is: `backend/worker.js`, a Cloudflare Worker (free plan is enough to start). It has no database, KV, or file storage, and it does not log request bodies. The photo lives in memory while the request runs, is sent to the Anthropic API, and the text comes back.

Hosting requirements:

- A Cloudflare account (free) and Node.js.
- An Anthropic API key. Usage is billed to that key, so set a spending limit. The Worker only answers requests from your site's origin, but a script can fake that header, so also consider a Cloudflare rate-limiting rule.

Setup:

```bash
cd backend
# 1. edit wrangler.toml: set ALLOWED_ORIGIN to your site origin, e.g. https://YOUR-USERNAME.github.io
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy        # prints https://ky-ocr.YOUR-SUBDOMAIN.workers.dev
```

Then in your GitHub repo go to **Settings → Secrets and variables → Actions → Variables** and add a variable named `ENHANCED_OCR_URL` with the Worker URL. Push (or re-run the workflow). An "Enhanced handwriting mode" switch appears.

Privacy implications, shown to users before first use:

- The photo is sent over HTTPS to your Worker and then to the AI provider.
- KY stores and logs nothing, but the AI provider processes the photo under its own terms and may retain API data for a limited time. Check the provider's current policy.
- Users must agree in a dialog before the mode turns on.

## How it works

| File | Purpose |
| --- | --- |
| `src/ocr.ts` | Tesseract.js OCR (runs in its own Web Worker) |
| `src/preprocess.ts` | Phone rotation, resize, grayscale |
| `src/parser.ts` | Indian receipt parser: dates, items, GST, totals, OCR digit repair, totals check |
| `src/excel.ts` | ExcelJS workbook with formats and formulas |
| `src/main.ts` | UI, editable table, download, share |
| `src/enhanced.ts`, `backend/` | Optional enhanced mode |
| `tests/` | Parser tests on printed, restaurant, IGST/HSN, handwritten-style and noisy OCR text; Excel round-trip tests |

The parser handles `DD/MM/YYYY`, `DD-MM-YY`, `12 Oct 2026`, Indian digit grouping (`1,23,456.00`), `Rs.` / `₹` / `/-`, qty-rate-amount columns, HSN columns, `2 x 60` lines, discounts and round-off, and common OCR mistakes such as `O` for `0`.

## Known limits

- **Handwriting is the weak spot** of browser OCR. Always review the table. Amber rows are low confidence. A green or red banner under each receipt compares the items with the printed total.
- Items that wrap onto two lines, or receipts with unusual column order, may be split wrongly. Edit or add rows by hand.
- Tilted, blurry, or dark photos reduce accuracy. Flat, well-lit, full-frame photos work best.
- HEIC photos (some iPhones) may not open in every browser. Use JPG/PNG or set the iPhone camera to Most Compatible.
- OCR engine files come from a CDN on first use, so the first receipt needs an internet connection.
