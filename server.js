const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');
const { nanoid } = require('nanoid');
const { run } = require('./lib/util');
const video = require('./lib/video');
const pdf = require('./lib/pdf');

const PORT = process.env.PORT || 4321;
const STORAGE = path.join(__dirname, 'storage');
const MAX_BYTES = 500 * 1024 * 1024;
const TTL_MS = 60 * 60 * 1000;
fs.mkdirSync(STORAGE, { recursive: true });

const app = express();
require('./lib/instagram').mount(app); // before body parsing: requests are streamed to the Python service
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- file registry ----------
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'mpeg', 'mpg', 'm4v', '3gp', 'ogv', 'ogg', 'ts', 'mts', 'm2ts', 'asf', 'gif'];
const IMAGE_EXT = ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'svg', 'psd', 'eps', 'ico'];

function kindOf(name) {
  const e = path.extname(name).slice(1).toLowerCase();
  if (e === 'pdf') return 'pdf';
  if (e === 'gif') return 'gif';
  if (VIDEO_EXT.includes(e)) return 'video';
  if (IMAGE_EXT.includes(e)) return 'image';
  if (e === 'zip') return 'zip';
  if (e === 'epub') return 'epub';
  return 'other';
}

const safeName = (n) => (path.basename(String(n || 'file')).replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '') || 'file').slice(0, 120);

function metaPath(id) {
  if (!/^[\w-]{6,40}$/.test(id)) throw Object.assign(new Error('Bad file id'), { status: 400 });
  return path.join(STORAGE, id, 'meta.json');
}
function getMeta(id) {
  const p = metaPath(id);
  if (!fs.existsSync(p)) throw Object.assign(new Error('File not found or expired. Please upload it again.'), { status: 404 });
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function register(srcPath, name, { move = true } = {}) {
  const id = nanoid(12);
  const dir = path.join(STORAGE, id);
  fs.mkdirSync(dir);
  const n = safeName(name);
  const dest = path.join(dir, n);
  if (move) fs.renameSync(srcPath, dest);
  else fs.copyFileSync(srcPath, dest);
  const kind = kindOf(n);
  const meta = { id, name: n, size: fs.statSync(dest).size, kind, created: Date.now(), url: `/f/${id}/${encodeURIComponent(n)}` };
  try {
    if (kind === 'video' || kind === 'gif') meta.info = await video.probe(dest);
    else if (kind === 'pdf') meta.info = await pdf.info(dest);
    else if (kind === 'image' && !/\.(heic|heif|psd|eps)$/i.test(n)) {
      const m = await require('sharp')(dest, { limitInputPixels: false }).metadata();
      meta.info = { width: m.width, height: m.height, pages: m.pages || 1 };
    }
  } catch (e) {
    meta.info = { error: e.message.split('\n')[0] };
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return meta;
}

const filePath = (m) => path.join(STORAGE, m.id, m.name);

// ---------- uploads ----------
const upload = multer({ dest: path.join(STORAGE, '_tmp'), limits: { fileSize: MAX_BYTES, files: 50 } });

app.post('/api/upload', upload.array('files', 50), async (req, res, next) => {
  try {
    const out = [];
    for (const f of req.files || []) out.push(await register(f.path, Buffer.from(f.originalname, 'latin1').toString('utf8')));
    if (!out.length) return res.status(400).json({ error: 'No file received.' });
    res.json({ files: out });
  } catch (e) {
    next(e);
  }
});

app.post('/api/upload-url', async (req, res, next) => {
  try {
    const url = String(req.body.url || '');
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Enter a valid http(s) URL.' });
    const host = new URL(url).hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1)/i.test(host)) return res.status(400).json({ error: 'That address is not allowed.' });
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return res.status(400).json({ error: `Download failed (HTTP ${r.status}).` });
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_BYTES) return res.status(400).json({ error: 'File is too large.' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) return res.status(400).json({ error: 'File is too large.' });
    let name = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'download');
    if (!path.extname(name)) {
      const ct = r.headers.get('content-type') || '';
      const ext = (ct.match(/\/(mp4|webm|quicktime|x-matroska|pdf|gif|png|jpeg|webp)/) || [])[1];
      const map = { quicktime: 'mov', 'x-matroska': 'mkv', jpeg: 'jpg' };
      if (ext) name += '.' + (map[ext] || ext);
    }
    const tmp = path.join(STORAGE, '_tmp', nanoid());
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, buf);
    res.json({ files: [await register(tmp, name)] });
  } catch (e) {
    next(e);
  }
});

app.get('/api/file/:id', (req, res, next) => {
  try {
    res.json(getMeta(req.params.id));
  } catch (e) {
    next(e);
  }
});

app.get('/f/:id/:name', (req, res, next) => {
  try {
    const m = getMeta(req.params.id);
    const p = filePath(m);
    if (req.query.dl) res.download(p, m.name);
    else res.sendFile(p);
  } catch (e) {
    next(e);
  }
});

// Rendered preview of a PDF page (cached)
app.get('/api/pdf-thumb/:id', async (req, res, next) => {
  try {
    const m = getMeta(req.params.id);
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const w = Math.min(1600, Math.max(100, parseInt(req.query.w || '800', 10)));
    const stem = path.join(STORAGE, m.id, `_thumb_${page}_${w}`);
    if (!fs.existsSync(`${stem}.png`)) {
      await run('pdftocairo', ['-png', '-singlefile', '-f', String(page), '-l', String(page), '-scale-to', String(w), filePath(m), stem]);
    }
    res.sendFile(`${stem}.png`);
  } catch (e) {
    next(e);
  }
});

// ---------- processing ----------
const HANDLERS = { ...video, ...pdf };
delete HANDLERS.probe;
delete HANDLERS.info;

let active = 0;
const queue = [];
const MAX_JOBS = 2;
function schedule(fn) {
  return new Promise((resolve, reject) => {
    const go = () => {
      active++;
      fn().then(resolve, reject).finally(() => {
        active--;
        if (queue.length) queue.shift()();
      });
    };
    if (active < MAX_JOBS) go();
    else queue.push(go);
  });
}

function zipFiles(files, dest) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const z = new ZipArchive({ zlib: { level: 6 } });
    out.on('close', resolve);
    z.on('error', reject);
    z.pipe(out);
    files.forEach((f) => z.file(f, { name: path.basename(f) }));
    z.finalize();
  });
}

app.post('/api/process', async (req, res, next) => {
  const { tool, inputs = [], opts = {} } = req.body || {};
  const handler = HANDLERS[tool];
  if (!handler) return res.status(400).json({ error: `Unknown tool: ${tool}` });
  if (!Array.isArray(inputs) || !inputs.length) return res.status(400).json({ error: 'Upload a file first.' });
  const work = path.join(STORAGE, '_work', nanoid());
  fs.mkdirSync(work, { recursive: true });
  const t0 = Date.now();
  try {
    const ins = inputs.map((id) => {
      const m = getMeta(id);
      return { ...m, path: filePath(m), info: m.info || {} };
    });
    const base = (path.parse(ins[0].name).name.replace(/-(mt|edited|out)\d*$/, '') || 'output').slice(0, 60) + (tool.includes('to-') || tool.includes('screenshot') ? '' : '-edited');
    const files = await schedule(() => handler({ inputs: ins, opts, work, base }));
    const outputs = [];
    for (const f of files) outputs.push(await register(f, path.basename(f)));
    let zip = null;
    if (files.length > 1) {
      const zp = path.join(work, `${path.parse(ins[0].name).name}-${tool}.zip`);
      await zipFiles(outputs.map(filePath), zp);
      zip = await register(zp, path.basename(zp));
    }
    res.json({ outputs, zip, inputSize: ins.reduce((s, i) => s + i.size, 0), ms: Date.now() - t0 });
  } catch (e) {
    next(e);
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => {});
  }
});

app.get('/api/capabilities', async (_req, res) => {
  const has = async (c) => run('/usr/bin/which', [c]).then(() => true, () => false);
  res.json({ ghostscript: await has('gs'), maxBytes: MAX_BYTES });
});

// SPA fallback
app.get(/^\/(video|pdf)(\/.*)?$/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 500 MB).' : err.message || 'Something went wrong.';
  if (status >= 500) console.error(err);
  res.status(status).json({ error: msg });
});

// ---------- cleanup: delete files older than 1 hour ----------
function cleanup() {
  const now = Date.now();
  for (const d of fs.readdirSync(STORAGE)) {
    const p = path.join(STORAGE, d);
    try {
      if (d === '_tmp' || d === '_work') {
        for (const f of fs.readdirSync(p)) {
          const fp = path.join(p, f);
          if (now - fs.statSync(fp).mtimeMs > TTL_MS * 2) fs.rmSync(fp, { recursive: true, force: true });
        }
      } else if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}
setInterval(cleanup, 10 * 60 * 1000).unref();
cleanup();

app.listen(PORT, () => console.log(`Media Toolkit running at http://localhost:${PORT}`));
