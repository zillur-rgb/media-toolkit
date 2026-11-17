const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { run, ffmpeg } = require('./util');

const SIPS_EXT = ['heic', 'heif', 'psd', 'bmp', 'eps', 'ico', 'icns', 'tga', 'jp2'];

async function which(cmd) {
  try {
    await run('/usr/bin/which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

/** Convert any supported image to PNG files. Returns list of PNG paths (multi-page TIFF yields several). */
async function toPngPages(input, outBase, { allPages = false } = {}) {
  const ext = path.extname(input.name).slice(1).toLowerCase();
  const out = [];
  if (ext === 'eps' || ext === 'ps') {
    if (await which('gs')) {
      await run('gs', ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dEPSCrop', '-sDEVICE=png16m', '-r200', `-sOutputFile=${outBase}-eps.png`, input.path]);
      return [`${outBase}-eps.png`];
    }
    try {
      await run('sips', ['-s', 'format', 'png', input.path, '--out', `${outBase}-eps.png`]);
      return [`${outBase}-eps.png`];
    } catch {
      throw new Error('EPS support needs Ghostscript on the server. Install it with: brew install ghostscript');
    }
  }
  if (SIPS_EXT.includes(ext)) {
    const p = `${outBase}.png`;
    try {
      await run('sips', ['-s', 'format', 'png', input.path, '--out', p]);
    } catch {
      await ffmpeg(['-i', input.path, '-frames:v', '1', p]);
    }
    return [p];
  }
  const meta = await sharp(input.path, { limitInputPixels: false }).metadata();
  const pages = allPages && meta.pages && ext !== 'gif' && ext !== 'webp' ? meta.pages : 1;
  for (let i = 0; i < pages; i++) {
    const p = `${outBase}-${i}.png`;
    const density = ext === 'svg' ? 200 : undefined;
    await sharp(input.path, { page: i, limitInputPixels: false, ...(density ? { density } : {}) }).rotate().png().toFile(p);
    out.push(p);
  }
  return out;
}

async function toPng(input, outPath) {
  const pages = await toPngPages(input, outPath.replace(/\.png$/, ''));
  fs.renameSync(pages[0], outPath);
  return outPath;
}

module.exports = { toPng, toPngPages, which };
