const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PDFDocument, degrees, StandardFonts, rgb } = require('pdf-lib');
const { run, ffmpeg, num, parseRanges, parseGroups, listFiles } = require('./util');
const { toPngPages } = require('./images');

const MM = 72 / 25.4;
// pdf-lib ignores Buffer.byteOffset, so always hand it a standalone copy.
const u8 = (b) => new Uint8Array(b);
const SIZES = {
  a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148], b5: [176, 250],
  letter: [215.9, 279.4], legal: [215.9, 355.6], tabloid: [279.4, 431.8],
};

async function load(file) {
  const bytes = fs.readFileSync(file);
  try {
    return await PDFDocument.load(u8(bytes), { ignoreEncryption: false, updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(e.message)) throw new Error('This PDF is password-protected/encrypted and cannot be edited.');
    throw new Error(`Could not read the PDF: ${e.message}`);
  }
}

async function info(file) {
  const out = await run('pdfinfo', [file]).catch(() => '');
  const pages = parseInt((out.match(/Pages:\s+(\d+)/) || [])[1] || '0', 10);
  const m = out.match(/Page size:\s+([\d.]+) x ([\d.]+) pts/);
  return { pages, pageWidth: m ? parseFloat(m[1]) : 0, pageHeight: m ? parseFloat(m[2]) : 0, encrypted: /Encrypted:\s+yes/.test(out) };
}

async function save(doc, file) {
  fs.writeFileSync(file, await doc.save({ useObjectStreams: true }));
  return file;
}

function pageSelection(opts, total) {
  const sel = opts.pages || 'all';
  if (sel === 'odd') return Array.from({ length: total }, (_, i) => i + 1).filter((n) => n % 2);
  if (sel === 'even') return Array.from({ length: total }, (_, i) => i + 1).filter((n) => n % 2 === 0);
  if (sel === 'custom') return parseRanges(opts.range, total);
  return parseRanges('all', total);
}

// ---------- Crop ----------
async function crop({ inputs, opts, work, base }) {
  const doc = await load(inputs[0].path);
  const pages = doc.getPages();
  const sel = pageSelection(opts, pages.length);
  const unit = opts.unit || 'percent';
  for (const n of sel) {
    const page = pages[n - 1];
    const box = page.getCropBox ? page.getCropBox() : page.getMediaBox();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const vw = rot % 180 ? box.height : box.width;
    const vh = rot % 180 ? box.width : box.height;
    const conv = (v, size) => (unit === 'percent' ? (num(v, 0, 0, 99) / 100) * size : num(v, 0, 0) * (unit === 'mm' ? MM : 1));
    const vis = { t: conv(opts.top, vh), r: conv(opts.right, vw), b: conv(opts.bottom, vh), l: conv(opts.left, vw) };
    let m;
    if (rot === 90) m = { l: vis.t, b: vis.l, r: vis.b, t: vis.r };
    else if (rot === 180) m = { t: vis.b, b: vis.t, l: vis.r, r: vis.l };
    else if (rot === 270) m = { r: vis.t, t: vis.l, l: vis.b, b: vis.r };
    else m = vis;
    const x = box.x + m.l;
    const y = box.y + m.b;
    const w = box.width - m.l - m.r;
    const h = box.height - m.t - m.b;
    if (w < 1 || h < 1) throw new Error('The crop area is empty. Reduce the margins.');
    page.setMediaBox(x, y, w, h);
    page.setCropBox(x, y, w, h);
    if (page.setTrimBox) page.setTrimBox(x, y, w, h);
    if (page.setBleedBox) page.setBleedBox(x, y, w, h);
    if (page.setArtBox) page.setArtBox(x, y, w, h);
  }
  return [await save(doc, path.join(work, `${base}.pdf`))];
}

// ---------- Rotate ----------
async function rotate({ inputs, opts, work, base }) {
  const doc = await load(inputs[0].path);
  const pages = doc.getPages();
  const angle = Number(opts.angle || 90);
  for (const n of pageSelection(opts, pages.length)) {
    const p = pages[n - 1];
    p.setRotation(degrees((((p.getRotation().angle + angle) % 360) + 360) % 360));
  }
  return [await save(doc, path.join(work, `${base}.pdf`))];
}

// ---------- Resize ----------
async function resize({ inputs, opts, work, base }) {
  const src = await load(inputs[0].path);
  const out = await PDFDocument.create();
  const srcPages = src.getPages();
  const embedded = await out.embedPages(srcPages);
  const margin = num(opts.margin, 0, 0, 100) * MM;
  for (let i = 0; i < srcPages.length; i++) {
    const sp = srcPages[i];
    const rot = ((sp.getRotation().angle % 360) + 360) % 360;
    const ep = embedded[i];
    const ew = rot % 180 ? ep.height : ep.width;
    const eh = rot % 180 ? ep.width : ep.height;
    let W, H;
    if (opts.mode === 'scale') {
      const s = num(opts.scale, 100, 1, 1000) / 100;
      W = ew * s; H = eh * s;
    } else {
      let dims;
      if (opts.size === 'custom') dims = [num(opts.customW, 210, 10, 5000), num(opts.customH, 297, 10, 5000)];
      else dims = SIZES[opts.size] || SIZES.a4;
      [W, H] = dims.map((d) => d * MM);
      const orient = opts.orientation || 'auto';
      const landscape = orient === 'landscape' || (orient === 'auto' && ew > eh);
      if (landscape !== W > H) [W, H] = [H, W];
    }
    const page = out.addPage([W, H]);
    const aw = W - margin * 2;
    const ah = H - margin * 2;
    let sx = aw / ew, sy = ah / eh;
    const fit = opts.mode === 'scale' ? 'stretch' : opts.fit || 'fit';
    if (fit === 'fit') sx = sy = Math.min(sx, sy);
    else if (fit === 'fill') sx = sy = Math.max(sx, sy);
    const dw = ew * sx, dh = eh * sy;
    const x0 = (W - dw) / 2, y0 = (H - dh) / 2;
    // Draw with the page's own rotation baked in.
    const draw = { xScale: sx, yScale: sy };
    if (rot === 0) page.drawPage(ep, { ...draw, x: x0, y: y0 });
    else if (rot === 90) page.drawPage(ep, { ...draw, x: x0, y: y0 + dh, rotate: degrees(-90), xScale: sy, yScale: sx });
    else if (rot === 180) page.drawPage(ep, { ...draw, x: x0 + dw, y: y0 + dh, rotate: degrees(180) });
    else page.drawPage(ep, { ...draw, x: x0 + dw, y: y0, rotate: degrees(90), xScale: sy, yScale: sx });
  }
  return [await save(out, path.join(work, `${base}.pdf`))];
}

// ---------- Compress ----------
async function compress({ inputs, opts, work, base }) {
  const input = inputs[0];
  const outFile = path.join(work, `${base}.pdf`);
  if (opts.mode === 'lossless') {
    const doc = await load(input.path);
    await save(doc, outFile);
  } else {
    const dpi = num(opts.dpi, 120, 36, 300);
    const quality = num(opts.quality, 70, 10, 100);
    const src = await load(input.path);
    const srcPages = src.getPages();
    const dir = path.join(work, 'render');
    fs.mkdirSync(dir, { recursive: true });
    await run('pdftocairo', ['-jpeg', '-r', String(dpi), '-jpegopt', `quality=${quality},optimize=y`, ...(opts.gray ? ['-gray'] : []),
      input.path, path.join(dir, 'p')]);
    const imgs = listFiles(dir, /\.jpg$/);
    const out = await PDFDocument.create();
    for (let i = 0; i < imgs.length; i++) {
      const sp = srcPages[i];
      const rot = sp ? ((sp.getRotation().angle % 360) + 360) % 360 : 0;
      const box = sp ? (sp.getCropBox ? sp.getCropBox() : sp.getMediaBox()) : null;
      const W = box ? (rot % 180 ? box.height : box.width) : 595;
      const H = box ? (rot % 180 ? box.width : box.height) : 842;
      const jpg = await out.embedJpg(u8(fs.readFileSync(imgs[i])));
      const page = out.addPage([W, H]);
      page.drawImage(jpg, { x: 0, y: 0, width: W, height: H });
    }
    await save(out, outFile);
  }
  const before = fs.statSync(input.path).size;
  const after = fs.statSync(outFile).size;
  if (after >= before && opts.mode === 'lossless') {
    // Nothing gained: keep the original bytes so the result is never bigger.
    fs.copyFileSync(input.path, outFile);
  }
  return [outFile];
}

// ---------- Merge ----------
async function merge({ inputs, work, base }) {
  if (inputs.length < 2) throw new Error('Upload at least two PDF files to merge.');
  const out = await PDFDocument.create();
  for (const inp of inputs) {
    if (!/\.pdf$/i.test(inp.name)) {
      // Allow images mixed in: turn each into a page.
      const tmp = path.join(work, `_img_${Math.random().toString(36).slice(2)}`);
      const pngs = await toPngPages(inp, tmp);
      for (const p of pngs) {
        const img = await out.embedPng(u8(fs.readFileSync(p)));
        const pg = out.addPage([img.width * 0.75, img.height * 0.75]);
        pg.drawImage(img, { x: 0, y: 0, width: pg.getWidth(), height: pg.getHeight() });
      }
      continue;
    }
    const doc = await load(inp.path);
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return [await save(out, path.join(work, `${base}.pdf`))];
}

// ---------- Split ----------
async function split({ inputs, opts, work, base }) {
  const src = await load(inputs[0].path);
  const total = src.getPageCount();
  let groups;
  const mode = opts.mode || 'each';
  if (mode === 'each') groups = Array.from({ length: total }, (_, i) => [i + 1]);
  else if (mode === 'every') {
    const n = Math.round(num(opts.every, 2, 1, total));
    groups = [];
    for (let i = 1; i <= total; i += n) groups.push(Array.from({ length: Math.min(n, total - i + 1) }, (_, k) => i + k));
  } else if (mode === 'ranges') {
    groups = parseGroups(opts.ranges, total);
    if (!groups.length) throw new Error('Enter at least one page range, e.g. 1-3; 4-6');
  } else if (mode === 'extract') {
    groups = [parseRanges(opts.ranges, total)];
  } else if (mode === 'remove') {
    const rm = new Set(parseRanges(opts.ranges, total));
    groups = [Array.from({ length: total }, (_, i) => i + 1).filter((p) => !rm.has(p))];
    if (!groups[0].length) throw new Error('You cannot remove every page.');
  }
  const files = [];
  for (const g of groups) {
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, g.map((p) => p - 1));
    pages.forEach((p) => out.addPage(p));
    const label = g.length === 1 ? `page-${g[0]}` : `pages-${g[0]}-${g[g.length - 1]}`;
    files.push(await save(out, path.join(work, groups.length === 1 && mode !== 'each' ? (mode === 'remove' ? `${base}.pdf` : `${base}-${label}.pdf`) : `${base}-${label}.pdf`)));
  }
  return files;
}

// ---------- PDF to images ----------
async function toImages({ inputs, opts, work, base }, fmt) {
  const input = inputs[0];
  const { pages: total } = await info(input.path);
  if (!total) throw new Error('Could not read the PDF.');
  const sel = opts.pages === 'custom' ? parseRanges(opts.range, total) : parseRanges('all', total).slice(0, 500);
  const dpi = num(opts.dpi, 150, 36, 600);
  const dir = path.join(work, 'pages');
  fs.mkdirSync(dir, { recursive: true });
  const pad = String(total).length;
  const files = [];
  for (const p of sel) {
    const stem = path.join(dir, `${base}-${String(p).padStart(pad, '0')}`);
    const range = ['-f', String(p), '-l', String(p)];
    if (fmt === 'svg') {
      await run('pdftocairo', ['-svg', ...range, input.path, `${stem}.svg`]);
      files.push(`${stem}.svg`);
      continue;
    }
    if (fmt === 'jpg') {
      await run('pdftocairo', ['-jpeg', '-singlefile', '-r', String(dpi), '-jpegopt', `quality=${Math.round(num(opts.quality, 90, 10, 100))}`, ...range, input.path, stem]);
      files.push(`${stem}.jpg`);
      continue;
    }
    if (fmt === 'tiff') {
      await run('pdftocairo', ['-tiff', '-singlefile', '-r', String(dpi), '-tiffcompression', 'lzw', ...range, input.path, stem]);
      files.push(`${stem}.tif`);
      continue;
    }
    await run('pdftocairo', ['-png', '-singlefile', '-r', String(dpi), ...(opts.transparent ? ['-transp'] : []), ...range, input.path, stem]);
    if (fmt === 'png') files.push(`${stem}.png`);
    else if (fmt === 'webp') {
      await sharp(`${stem}.png`).webp({ quality: Math.round(num(opts.quality, 90, 10, 100)) }).toFile(`${stem}.webp`);
      fs.unlinkSync(`${stem}.png`);
      files.push(`${stem}.webp`);
    } else files.push(`${stem}.png`); // gif handled below
  }
  if (fmt !== 'gif') return files;

  // GIF: animated slideshow of the pages, or one GIF per page
  if (opts.gifMode === 'separate') {
    const gifs = [];
    for (const f of files) {
      const g = f.replace(/\.png$/, '.gif');
      await ffmpeg(['-i', f, '-vf', 'split[a][b];[a]palettegen[p];[b][p]paletteuse', g]);
      fs.unlinkSync(f);
      gifs.push(g);
    }
    return gifs;
  }
  const delay = num(opts.delay, 1, 0.05, 30);
  // Normalise all frames to the first page's size so the animation is stable
  const m = await sharp(files[0]).metadata();
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'\nduration ${delay}`).join('\n') + `\nfile '${files[files.length - 1].replace(/'/g, "'\\''")}'\n`);
  const out = path.join(work, `${base}.gif`);
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf',
    `scale=${m.width}:${m.height}:force_original_aspect_ratio=decrease,pad=${m.width}:${m.height}:(ow-iw)/2:(oh-ih)/2:color=white,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a`,
    '-fps_mode', 'vfr', '-loop', '0', out]);
  return [out];
}

// ---------- Images to PDF ----------
async function imagesToPdf({ inputs, opts, work, base }) {
  if (!inputs.length) throw new Error('Upload at least one image.');
  const out = await PDFDocument.create();
  const margin = num(opts.margin, 0, 0, 100) * MM;
  const prep = path.join(work, 'prep');
  fs.mkdirSync(prep, { recursive: true });
  let idx = 0;
  for (const inp of inputs) {
    const ext = path.extname(inp.name).slice(1).toLowerCase();
    if (ext === 'pdf') {
      const doc = await load(inp.path);
      (await out.copyPages(doc, doc.getPageIndices())).forEach((p) => out.addPage(p));
      continue;
    }
    if (ext === 'epub') {
      await epubInto(out, inp, work);
      continue;
    }
    if (ext === 'eps' || ext === 'ps') {
      // Vector route if Ghostscript is present
      const { which } = require('./images');
      if (await which('gs')) {
        const pdfTmp = path.join(prep, `${idx++}.pdf`);
        await run('gs', ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dEPSCrop', '-sDEVICE=pdfwrite', `-sOutputFile=${pdfTmp}`, inp.path]);
        const doc = await PDFDocument.load(u8(fs.readFileSync(pdfTmp)));
        (await out.copyPages(doc, doc.getPageIndices())).forEach((p) => out.addPage(p));
        continue;
      }
    }
    let imgs;
    if ((ext === 'jpg' || ext === 'jpeg' || ext === 'jfif') && opts.quality !== 'compress') {
      // JPEG goes in as-is (but honour EXIF orientation)
      const meta = await sharp(inp.path).metadata();
      const buf = meta.orientation && meta.orientation > 1 ? await sharp(inp.path).rotate().jpeg({ quality: 95 }).toBuffer() : fs.readFileSync(inp.path);
      imgs = [{ img: await out.embedJpg(u8(buf)) }];
    } else {
      const pngs = await toPngPages(inp, path.join(prep, String(idx++)), { allPages: true });
      imgs = [];
      for (const p of pngs) {
        if (opts.quality === 'compress') {
          const buf = await sharp(p).flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
          imgs.push({ img: await out.embedJpg(u8(buf)) });
        } else imgs.push({ img: await out.embedPng(u8(fs.readFileSync(p))) });
      }
    }
    for (const { img } of imgs) {
      // 96 dpi baseline: 1px = 0.75pt
      const iw = img.width * 0.75, ih = img.height * 0.75;
      let W, H;
      if (!opts.size || opts.size === 'image') {
        W = iw + margin * 2; H = ih + margin * 2;
      } else {
        [W, H] = (SIZES[opts.size] || SIZES.a4).map((d) => d * MM);
        const orient = opts.orientation || 'auto';
        const landscape = orient === 'landscape' || (orient === 'auto' && iw > ih);
        if (landscape !== W > H) [W, H] = [H, W];
      }
      const page = out.addPage([W, H]);
      const aw = W - margin * 2, ah = H - margin * 2;
      const s = Math.min(aw / iw, ah / ih);
      const dw = iw * s, dh = ih * s;
      page.drawImage(img, { x: (W - dw) / 2, y: (H - dh) / 2, width: dw, height: dh });
    }
  }
  if (!out.getPageCount()) throw new Error('Nothing could be converted.');
  return [await save(out, path.join(work, `${base}.pdf`))];
}

// ---------- ePub (basic text + images layout) ----------
async function epubInto(out, inp, work) {
  const dir = path.join(work, `epub_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  await run('unzip', ['-qq', '-o', inp.path, '-d', dir]);
  const container = fs.readFileSync(path.join(dir, 'META-INF', 'container.xml'), 'utf8');
  const opfRel = (container.match(/full-path="([^"]+)"/) || [])[1];
  if (!opfRel) throw new Error('Invalid ePub: no package file.');
  const opfPath = path.join(dir, opfRel);
  const opf = fs.readFileSync(opfPath, 'utf8');
  const opfDir = path.dirname(opfPath);
  const manifest = {};
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = (m[0].match(/\bid="([^"]+)"/) || [])[1];
    const href = (m[0].match(/\bhref="([^"]+)"/) || [])[1];
    if (id && href) manifest[id] = decodeURIComponent(href);
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => manifest[m[1]]).filter(Boolean);
  const title = (opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/) || [])[1];

  const font = await out.embedFont(StandardFonts.TimesRoman);
  const bold = await out.embedFont(StandardFonts.TimesRomanBold);
  const W = 420, H = 595, M = 48, size = 11.5, lh = 16;
  let page = null, y = 0;
  const newPage = () => { page = out.addPage([W, H]); y = H - M; };
  const clean = (s) => s.replace(/[^\x20-\x7E\u00A0-\u00FF\u2018\u2019\u201C\u201D\u2013\u2014\u2026]/g, '')
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u2013/g, '-').replace(/\u2014/g, '--').replace(/\u2026/g, '...');
  const ent = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  const writePara = (text, f, fs_, gapAfter) => {
    const words = clean(text).split(/\s+/).filter(Boolean);
    if (!words.length) return;
    let line = '';
    const flush = () => {
      if (y < M + fs_) newPage();
      page.drawText(line, { x: M, y, size: fs_, font: f, color: rgb(0.1, 0.1, 0.1) });
      y -= fs_ * 1.4;
      line = '';
    };
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(t, fs_) > W - M * 2 && line) { flush(); line = w; } else line = t;
    }
    if (line) flush();
    y -= gapAfter;
  };
  newPage();
  if (title) { y = H / 2; writePara(ent(title), bold, 24, 0); newPage(); }
  for (const rel of spine) {
    const file = path.join(opfDir, rel.split('#')[0]);
    if (!fs.existsSync(file) || !/\.(x?html?|xml)$/i.test(file)) continue;
    const html = fs.readFileSync(file, 'utf8').replace(/<head[\s\S]*?<\/head>/i, '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
    if (y < H - M - 1) newPage();
    const blocks = html.split(/(?=<(?:p|h[1-6]|div|li|blockquote|img|image|br)\b)/i);
    for (const b of blocks) {
      const img = b.match(/^<(?:img|image)\b[^>]*(?:src|xlink:href|href)="([^"]+)"/i);
      if (img) {
        try {
          const ip = path.join(path.dirname(file), decodeURIComponent(img[1]));
          const png = await sharp(ip).flatten({ background: '#fff' }).jpeg({ quality: 85 }).toBuffer();
          const e = await out.embedJpg(u8(png));
          const s = Math.min((W - M * 2) / e.width, (H - M * 2) / e.height, 1);
          if (y - e.height * s < M) newPage();
          page.drawImage(e, { x: (W - e.width * s) / 2, y: y - e.height * s, width: e.width * s, height: e.height * s });
          y -= e.height * s + 10;
        } catch { /* skip unreadable image */ }
      }
      const heading = b.match(/^<h([1-6])\b/i);
      const text = ent(b.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (heading) { y -= 6; writePara(text, bold, Math.max(13, 22 - Number(heading[1]) * 2), 6); } else writePara(text, font, size, lh * 0.35);
    }
  }
}

module.exports = {
  'crop-pdf': crop,
  'rotate-pdf': rotate,
  'resize-pdf': resize,
  'compress-pdf': compress,
  'merge-pdf': merge,
  'split-pdf': split,
  'pdf-to-gif': (c) => toImages(c, 'gif'),
  'pdf-to-jpg': (c) => toImages(c, 'jpg'),
  'pdf-to-png': (c) => toImages(c, 'png'),
  'pdf-to-webp': (c) => toImages(c, 'webp'),
  'pdf-to-svg': (c) => toImages(c, 'svg'),
  'pdf-to-tiff': (c) => toImages(c, 'tiff'),
  'images-to-pdf': imagesToPdf,
  info,
};
