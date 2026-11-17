const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Run a command, resolve with stdout; reject with the tail of stderr. */
function run(cmd, args, { cwd, timeout = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 200000) err = err.slice(-100000);
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} failed to start: ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else {
        const tail = err.trim().split('\n').slice(-6).join('\n');
        reject(new Error(`${path.basename(cmd)} exited with code ${code}\n${tail}`));
      }
    });
  });
}

const ffmpeg = (args, opts) => run('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', ...args], opts);

async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  let fps = 0;
  if (v) {
    const [n, d] = (v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate || '0/1').split('/').map(Number);
    fps = d ? n / d : 0;
  }
  let width = v ? v.width : 0;
  let height = v ? v.height : 0;
  const rot = v ? rotationOf(v) : 0;
  if (Math.abs(rot) % 180 === 90) [width, height] = [height, width];
  return {
    duration: parseFloat(j.format?.duration || v?.duration || 0) || 0,
    width,
    height,
    fps: Math.round(fps * 100) / 100,
    hasVideo: !!v,
    hasAudio: !!a,
    vcodec: v?.codec_name,
    acodec: a?.codec_name,
    format: j.format?.format_name,
  };
}

function rotationOf(v) {
  const sd = (v.side_data_list || []).find((s) => s.rotation !== undefined);
  if (sd) return Number(sd.rotation) || 0;
  if (v.tags && v.tags.rotate) return Number(v.tags.rotate) || 0;
  return 0;
}

const num = (v, def, min = -Infinity, max = Infinity) => {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Parse "1-3,5,7-" style page ranges into a sorted list of 1-based page numbers. */
function parseRanges(spec, total) {
  if (!spec || !String(spec).trim() || String(spec).trim().toLowerCase() === 'all') {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : total;
      for (let i = Math.max(1, a); i <= Math.min(total, b); i++) set.add(i);
    } else if (/^\d+$/.test(p)) {
      const i = parseInt(p, 10);
      if (i >= 1 && i <= total) set.add(i);
    } else throw new Error(`Invalid page range: "${p}"`);
  }
  if (!set.size) throw new Error('The page range does not match any pages.');
  return [...set].sort((a, b) => a - b);
}

/** Parse "a-b; c-d" into groups for splitting. */
function parseGroups(spec, total) {
  return String(spec)
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((g) => parseRanges(g, total));
}

/** Parse a time like "1:23.5", "83.5" into seconds. */
function parseTime(v, def = 0) {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim();
  if (/^[\d.]+$/.test(s)) return parseFloat(s);
  const parts = s.split(':').map(parseFloat);
  if (parts.some((p) => !Number.isFinite(p))) return def;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function listFiles(dir, re) {
  return fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => path.join(dir, f));
}

module.exports = { run, ffmpeg, probe, num, even, parseRanges, parseGroups, parseTime, listFiles };
