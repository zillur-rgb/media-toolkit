# MediaKit — video & PDF tools

A self-hosted web app with online video and PDF tools: upload a file, choose options, download the result, or send it on to another tool.

## Run

```bash
npm install
npm start          # http://localhost:4321
```

Requirements (macOS/Homebrew): `ffmpeg`, `poppler` (pdftocairo/pdfinfo). Optional: `ghostscript` for EPS → PDF.

## Tools

**Video** — Video to GIF / WebP / APNG / AVIF · Resize · Crop (drag to select) · Rotate & flip · Reverse · Loop / boomerang · Cut ·
Filters (color, blur, sharpen, sepia, grayscale, pixelate…) · Speed · Watermark (text or image) · Merge · Mixer (side by side, stacked,
2×2 grid, picture-in-picture) · Freeze frame · Frame interpolation · Change aspect ratio · Video to JPG/PNG frames · Images to video ·
Screenshot · Convert to MP4 / WebM / MOV / MKV (with auto black-bar removal).

**PDF** — Crop (drag to select) · Rotate · Resize · Compress · Merge · Split / extract / remove pages · PDF to GIF / JPG / PNG / WebP / SVG / TIFF ·
GIF / JPG / PNG / WebP / HEIC / SVG / TIFF / JFIF / BMP / AVIF / EPS / PSD / ePub to PDF.

## Layout

- `server.js` — Express: uploads (file or URL), processing queue, downloads, ZIP bundles, 1-hour auto-cleanup in `storage/`
- `lib/video.js` — ffmpeg-based video handlers
- `lib/pdf.js` — pdf-lib + poppler PDF handlers
- `lib/images.js` — image normalization (sharp, macOS `sips` for HEIC/PSD/BMP)
- `public/tools.js` — tool registry (navigation + option forms); `public/app.js` — UI

## Instagram downloader (`/instagram`)

Python (FastAPI) backend + Vue 3 (Vite) frontend, mounted into MediaKit: `npm start` also starts the Python service
(port 8001) and proxies `/api/ig/*` to it; the built Vue app is served at `/instagram/`.

Downloads public **videos, photos, reels, IGTV, carousels** and **profile pictures** (plus a profile's 12 latest posts).
Media is streamed through `/api/ig/media`, which only fetches from Instagram's CDN hosts.

### One-time setup

```bash
cd instagram/backend && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd ../frontend && npm install && npm run build
```

### Frontend development

```bash
cd instagram/frontend && npm run dev   # http://localhost:5173/instagram/ (needs `npm start` running)
```

### Stories & highlights (optional)

Instagram only shows stories to logged-in users. To enable them, create a session once with a **dedicated** account
and start the server with its username:

```bash
instagram/backend/.venv/bin/instaloader -l YOUR_ACCOUNT
IG_USERNAME=YOUR_ACCOUNT npm start
```

Notes: only public content works anonymously; Instagram rate-limits heavy use (the backend caches lookups for 15 min).
Only download content you have the right to use.
