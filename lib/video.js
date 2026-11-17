const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { ffmpeg, probe, num, even, parseTime, listFiles } = require('./util');

const VIDEO_OUT = ['mp4', 'webm', 'mov', 'mkv'];

function outExt(input, wanted) {
  if (wanted && VIDEO_OUT.includes(wanted)) return wanted;
  const e = path.extname(input.name).slice(1).toLowerCase();
  return VIDEO_OUT.includes(e) ? e : 'mp4';
}

/** Encoder arguments for a given container. */
function enc(ext, { audio = true, crf, preset = 'veryfast' } = {}) {
  const a = audio ? null : ['-an'];
  if (ext === 'webm') {
    return [
      '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf ?? 33), '-deadline', 'realtime', '-cpu-used', '8',
      '-row-mt', '1', '-pix_fmt', 'yuv420p',
      ...(a || ['-c:a', 'libopus', '-b:a', '128k']),
    ];
  }
  return [
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf ?? 23), '-pix_fmt', 'yuv420p',
    ...(ext === 'mp4' || ext === 'mov' ? ['-movflags', '+faststart'] : []),
    ...(a || ['-c:a', 'aac', '-b:a', '160k']),
  ];
}

/** Trim args (input seeking) from start/end options. */
function trimArgs(opts, info) {
  const start = parseTime(opts.start, 0);
  const end = parseTime(opts.end, info.duration || 0);
  const args = [];
  if (start > 0) args.push('-ss', String(start));
  if (end > start && (!info.duration || end < info.duration - 0.01 || start > 0)) args.push('-t', String(end - start));
  return args;
}

const scaleExpr = (w) => (w && w !== 'original' && Number(w) > 0 ? `scale=${even(Number(w))}:-2:flags=lanczos` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2');

// ---------- Video to animated image ----------
async function toAnim({ inputs, opts, work, base }, fmt) {
  const input = inputs[0];
  const info = input.info;
  const fps = num(opts.fps, 10, 1, 50);
  const width = opts.width;
  const t = trimArgs(opts, info);
  const out = path.join(work, `${base}.${fmt === 'webp' ? 'gif' : fmt}`);
  const scale = width && width !== 'original' ? `scale=${Math.round(Number(width))}:-1:flags=lanczos` : 'scale=iw:-1';
  if (fmt === 'gif' || fmt === 'webp') {
    const dither = opts.dither || 'sierra2_4a';
    const statsMode = opts.method === 'diff' ? 'diff' : 'full';
    const colors = num(opts.colors, 256, 2, 256);
    await ffmpeg([...t, '-i', input.path, '-vf',
      `fps=${fps},${scale},split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=${statsMode}[p];[b][p]paletteuse=dither=${dither}`,
      '-loop', opts.loop === 'no' ? '-1' : '0', out]);
    if (fmt === 'webp') {
      const webp = path.join(work, `${base}.webp`);
      await sharp(out, { animated: true, limitInputPixels: false })
        .webp({ quality: num(opts.quality, 80, 1, 100), loop: opts.loop === 'no' ? 1 : 0 })
        .toFile(webp);
      fs.unlinkSync(out);
      return [webp];
    }
    return [out];
  }
  if (fmt === 'apng') {
    const apng = path.join(work, `${base}.png`);
    await ffmpeg([...t, '-i', input.path, '-vf', `fps=${fps},${scale}`, '-plays', opts.loop === 'no' ? '1' : '0', '-f', 'apng', apng]);
    return [apng];
  }
  if (fmt === 'avif') {
    const sc = width && width !== 'original' ? `scale=${even(Number(width))}:-2:flags=lanczos` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    await ffmpeg([...t, '-i', input.path, '-vf', `fps=${fps},${sc},format=yuv420p`, '-c:v', 'libsvtav1',
      '-crf', String(Math.round(63 - num(opts.quality, 60, 1, 100) * 0.55)), '-preset', '8', '-an', '-f', 'avif', out]);
    return [out];
  }
  throw new Error('Unsupported format');
}

// ---------- Simple filter-based tools ----------
async function vf({ inputs, opts, work, base }, filter, { audioFilter, audio = true, ext } = {}) {
  const input = inputs[0];
  const e = outExt(input, ext || opts.format);
  const out = path.join(work, `${base}.${e}`);
  const keepAudio = audio && input.info.hasAudio && opts.sound !== 'mute';
  const args = ['-i', input.path];
  if (filter) args.push('-vf', filter);
  if (keepAudio && audioFilter) args.push('-af', audioFilter);
  args.push(...enc(e, { audio: keepAudio }), out);
  await ffmpeg(args);
  return [out];
}

const resize = (ctx) => {
  const { opts, inputs } = ctx;
  const info = inputs[0].info;
  let w = num(opts.width, 0, 0, 7680);
  let h = num(opts.height, 0, 0, 7680);
  if (opts.percent && num(opts.percent, 0) > 0) {
    const p = num(opts.percent, 100, 1, 400) / 100;
    w = info.width * p;
    h = 0;
  }
  if (!w && !h) throw new Error('Enter a width, a height or a percentage.');
  let filter;
  if (w && h && opts.fit === 'pad') {
    filter = `scale=${even(w)}:${even(h)}:force_original_aspect_ratio=decrease,pad=${even(w)}:${even(h)}:(ow-iw)/2:(oh-ih)/2:color=${opts.color || 'black'},setsar=1`;
  } else if (w && h && opts.fit === 'crop') {
    filter = `scale=${even(w)}:${even(h)}:force_original_aspect_ratio=increase,crop=${even(w)}:${even(h)},setsar=1`;
  } else {
    filter = `scale=${w ? even(w) : -2}:${h ? even(h) : -2}:flags=lanczos,setsar=1`;
  }
  return vf(ctx, filter);
};

const crop = (ctx) => {
  const { opts, inputs } = ctx;
  const info = inputs[0].info;
  const x = Math.round(num(opts.x, 0, 0, info.width));
  const y = Math.round(num(opts.y, 0, 0, info.height));
  const w = Math.floor(num(opts.w, info.width, 2, info.width - x) / 2) * 2;
  const h = Math.floor(num(opts.h, info.height, 2, info.height - y) / 2) * 2;
  return vf(ctx, `crop=${w}:${h}:${x}:${y}`);
};

const rotate = (ctx) => {
  const { opts } = ctx;
  const f = [];
  const a = String(opts.angle || '0');
  if (a === '90') f.push('transpose=1');
  else if (a === '270') f.push('transpose=2');
  else if (a === '180') f.push('hflip,vflip');
  if (opts.flip === 'h' || opts.flip === 'both') f.push('hflip');
  if (opts.flip === 'v' || opts.flip === 'both') f.push('vflip');
  if (!f.length) throw new Error('Choose a rotation or a flip.');
  return vf(ctx, f.join(','));
};

const reverse = (ctx) => vf(ctx, 'reverse', { audioFilter: 'areverse', audio: ctx.opts.sound !== 'mute' });

async function loop({ inputs, opts, work, base }) {
  const input = inputs[0];
  const times = Math.round(num(opts.times, 3, 2, 50));
  const e = outExt(input, opts.format);
  const out = path.join(work, `${base}.${e}`);
  if (opts.mode === 'boomerang') {
    const hasA = input.info.hasAudio;
    const fc = `[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1:a=0,loop=loop=${times - 1}:size=32767:start=0[v]`;
    await ffmpeg(['-i', input.path, '-filter_complex', fc, '-map', '[v]', ...enc(e, { audio: false }), out]);
    void hasA;
    return [out];
  }
  await ffmpeg(['-stream_loop', String(times - 1), '-i', input.path, ...enc(e, { audio: input.info.hasAudio }), out]);
  return [out];
}

async function cut({ inputs, opts, work, base }) {
  const input = inputs[0];
  const info = input.info;
  const start = parseTime(opts.start, 0);
  const end = parseTime(opts.end, info.duration);
  if (!(end > start)) throw new Error('End time must be after the start time.');
  const e = outExt(input, opts.format);
  const out = path.join(work, `${base}.${e}`);
  if (opts.mode === 'copy' && e === path.extname(input.name).slice(1).toLowerCase()) {
    await ffmpeg(['-ss', String(start), '-i', input.path, '-t', String(end - start), '-c', 'copy', '-avoid_negative_ts', 'make_zero', out]);
  } else {
    await ffmpeg(['-ss', String(start), '-i', input.path, '-t', String(end - start), ...enc(e, { audio: info.hasAudio }), out]);
  }
  return [out];
}

function filters(ctx) {
  const o = ctx.opts;
  const f = [];
  const eq = [];
  const b = num(o.brightness, 0, -100, 100);
  const c = num(o.contrast, 0, -100, 100);
  const s = num(o.saturation, 0, -100, 100);
  const g = num(o.gamma, 0, -100, 100);
  if (b) eq.push(`brightness=${(b / 100).toFixed(3)}`);
  if (c) eq.push(`contrast=${(1 + c / 100).toFixed(3)}`);
  if (s) eq.push(`saturation=${(1 + s / 100).toFixed(3)}`);
  if (g) eq.push(`gamma=${Math.pow(2, g / 50).toFixed(3)}`);
  if (eq.length) f.push(`eq=${eq.join(':')}`);
  const hue = num(o.hue, 0, -180, 180);
  if (hue) f.push(`hue=h=${hue}`);
  if (o.grayscale) f.push('hue=s=0');
  if (o.sepia) f.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
  if (o.negative) f.push('negate');
  const blur = num(o.blur, 0, 0, 50);
  if (blur) f.push(`gblur=sigma=${blur}`);
  const sharpen = num(o.sharpen, 0, 0, 5);
  if (sharpen) f.push(`unsharp=5:5:${sharpen}:5:5:0`);
  const noise = num(o.noise, 0, 0, 100);
  if (noise) f.push(`noise=alls=${noise}:allf=t`);
  if (o.vignette) f.push('vignette=PI/4');
  if (o.mirror) f.push('hflip');
  if (o.flipv) f.push('vflip');
  if (o.edges) f.push('edgedetect=mode=colormix');
  if (o.pixelate) {
    const px = num(o.pixelSize, 10, 2, 100);
    const { width: W, height: H } = ctx.inputs[0].info;
    f.push(`scale=trunc(iw/${px}):trunc(ih/${px}),scale=${W || 'iw'}:${H || 'ih'}:flags=neighbor`);
  }
  if (!f.length) throw new Error('Choose at least one filter.');
  f.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  return vf(ctx, f.join(','));
}

function atempoChain(f) {
  const parts = [];
  let r = f;
  while (r > 2) { parts.push(2); r /= 2; }
  while (r < 0.5) { parts.push(0.5); r /= 0.5; }
  parts.push(r);
  return parts.map((p) => `atempo=${p.toFixed(5)}`).join(',');
}

const speed = (ctx) => {
  const f = num(ctx.opts.speed, 2, 0.1, 16);
  const keepSound = ctx.opts.sound === 'keep';
  return vf(ctx, `setpts=PTS/${f}`, { audioFilter: atempoChain(f), audio: keepSound });
};

function placeExpr(pos, m) {
  const map = {
    tl: [`${m}`, `${m}`], tc: [`(W-w)/2`, `${m}`], tr: [`W-w-${m}`, `${m}`],
    ml: [`${m}`, `(H-h)/2`], c: [`(W-w)/2`, `(H-h)/2`], mr: [`W-w-${m}`, `(H-h)/2`],
    bl: [`${m}`, `H-h-${m}`], bc: [`(W-w)/2`, `H-h-${m}`], br: [`W-w-${m}`, `H-h-${m}`],
  };
  return map[pos] || map.br;
}

function escXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

async function textPng(text, { size, color, font, bg, stroke }, file) {
  const lines = String(text).split('\n');
  const lh = size * 1.25;
  const estW = Math.ceil(Math.max(...lines.map((l) => l.length)) * size * 0.62) + size;
  const h = Math.ceil(lines.length * lh + size * 0.5);
  const tspans = lines.map((l, i) => `<tspan x="50%" y="${(i + 1) * lh - size * 0.15}">${escXml(l) || ' '}</tspan>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${estW}" height="${h}">
    ${bg ? `<rect width="100%" height="100%" rx="${size * 0.2}" fill="${escXml(bg)}"/>` : ''}
    <text font-family="${escXml(font)}" font-size="${size}" font-weight="700" fill="${escXml(color)}" text-anchor="middle"
      ${stroke ? `stroke="${escXml(stroke)}" stroke-width="${Math.max(1, size / 14)}" paint-order="stroke"` : ''}>${tspans}</text></svg>`;
  if (bg) await sharp(Buffer.from(svg)).png().toFile(file);
  else {
    await sharp(Buffer.from(svg)).trim({ threshold: 0 })
      .extend({ top: 4, bottom: 4, left: 6, right: 6, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(file);
  }
  return file;
}

async function watermark({ inputs, opts, work, base }) {
  const input = inputs[0];
  const info = input.info;
  let wm;
  if (opts.type === 'image') {
    if (!inputs[1]) throw new Error('Upload a watermark image (second file).');
    wm = inputs[1].path;
  } else {
    if (!opts.text) throw new Error('Enter watermark text.');
    const size = Math.round(num(opts.fontSize, Math.max(16, info.height / 14), 6, 400));
    wm = await textPng(opts.text, {
      size, color: opts.color || '#ffffff', font: opts.font || 'Helvetica, Arial, sans-serif',
      bg: opts.bg === 'box' ? 'rgba(0,0,0,0.55)' : '', stroke: opts.bg === 'outline' ? '#000000' : '',
    }, path.join(work, '_wm.png'));
  }
  const opacity = num(opts.opacity, 80, 1, 100) / 100;
  const margin = Math.round(num(opts.margin, 16, 0, 2000));
  const [x, y] = placeExpr(opts.position || 'br', margin);
  const scalePct = num(opts.scale, 20, 1, 100);
  const scale = opts.type === 'image' ? `scale=${even((info.width * scalePct) / 100)}:-1,` : '';
  const e = outExt(input, opts.format);
  const out = path.join(work, `${base}.${e}`);
  const fc = `[1:v]${scale}format=rgba,colorchannelmixer=aa=${opacity}[wm];[0:v][wm]overlay=${x}:${y}:format=auto,format=yuv420p[v]`;
  await ffmpeg(['-i', input.path, '-loop', '1', '-i', wm, '-filter_complex', fc, '-map', '[v]', '-map', '0:a?', '-shortest',
    ...enc(e, { audio: info.hasAudio }), out]);
  return [out];
}

async function merge({ inputs, opts, work, base }) {
  if (inputs.length < 2) throw new Error('Upload at least two videos to merge.');
  const first = inputs[0].info;
  const W = even(num(opts.width, first.width, 16, 3840));
  const H = even(num(opts.height, first.height, 16, 3840));
  const fps = num(opts.fps, Math.min(60, Math.round(first.fps) || 30), 1, 60);
  const sound = opts.sound !== 'mute' && inputs.some((i) => i.info.hasAudio);
  const args = [];
  inputs.forEach((i) => args.push('-i', i.path));
  let extra = inputs.length;
  const parts = [];
  const labels = [];
  inputs.forEach((inp, idx) => {
    parts.push(`[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${idx}]`);
    labels.push(`[v${idx}]`);
    if (sound) {
      if (inp.info.hasAudio) {
        parts.push(`[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${idx}]`);
      } else {
        args.push('-f', 'lavfi', '-t', String(inp.info.duration || 1), '-i', 'anullsrc=r=44100:cl=stereo');
        parts.push(`[${extra}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${idx}]`);
        extra++;
      }
      labels.push(`[a${idx}]`);
    }
  });
  parts.push(`${labels.join('')}concat=n=${inputs.length}:v=1:a=${sound ? 1 : 0}[v]${sound ? '[a]' : ''}`);
  const e = VIDEO_OUT.includes(opts.format) ? opts.format : 'mp4';
  const out = path.join(work, `${base}.${e}`);
  await ffmpeg([...args, '-filter_complex', parts.join(';'), '-map', '[v]', ...(sound ? ['-map', '[a]'] : []), ...enc(e, { audio: sound }), out]);
  return [out];
}

async function mixer({ inputs, opts, work, base }) {
  if (inputs.length < 2) throw new Error('Upload at least two videos.');
  const layout = opts.layout || 'hstack';
  const n = layout === 'grid' ? Math.min(4, inputs.length) : layout === 'pip' ? 2 : Math.min(6, inputs.length);
  const ins = inputs.slice(0, n);
  const args = [];
  ins.forEach((i) => args.push('-i', i.path));
  const first = ins[0].info;
  const parts = [];
  const size = even(num(opts.size, layout === 'vstack' ? Math.min(first.width, 1280) : Math.min(first.height, 720), 64, 2160));
  const fps = Math.min(60, Math.round(first.fps) || 30);
  if (layout === 'hstack' || layout === 'vstack') {
    ins.forEach((_, k) => parts.push(`[${k}:v]${layout === 'hstack' ? `scale=-2:${size}` : `scale=${size}:-2`},setsar=1,fps=${fps}[s${k}]`));
    parts.push(`${ins.map((_, k) => `[s${k}]`).join('')}${layout}=inputs=${n}:shortest=${opts.duration === 'longest' ? 0 : 1}[v0]`);
  } else if (layout === 'grid') {
    const cw = even((first.width / first.height) * (size / 2));
    const ch = even(size / 2);
    const cells = [];
    for (let k = 0; k < 4; k++) {
      if (k < n) parts.push(`[${k}:v]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[s${k}]`);
      else parts.push(`color=c=black:s=${cw}x${ch}:r=${fps}[s${k}]`);
      cells.push(`[s${k}]`);
    }
    parts.push(`${cells.join('')}xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0:shortest=1[v0]`);
  } else {
    const pipPct = num(opts.pipSize, 30, 10, 60) / 100;
    const mainW = even(first.width);
    const [x, y] = placeExpr(opts.position || 'br', 20);
    parts.push(`[0:v]scale=${mainW}:-2,setsar=1[m]`);
    parts.push(`[1:v]scale=${even(mainW * pipPct)}:-2,setsar=1[p]`);
    parts.push(`[m][p]overlay=${x}:${y}:shortest=${opts.duration === 'longest' ? 0 : 1}:eof_action=pass[v0]`);
  }
  parts.push('[v0]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[v]');
  const audioIdx = ins.map((x, k) => (x.info.hasAudio ? k : -1)).filter((k) => k >= 0);
  let amap = [];
  if (opts.audio === 'mix' && audioIdx.length > 1) {
    parts.push(`${audioIdx.map((k) => `[${k}:a]`).join('')}amix=inputs=${audioIdx.length}:duration=${opts.duration === 'longest' ? 'longest' : 'shortest'}[a]`);
    amap = ['-map', '[a]'];
  } else if (opts.audio !== 'none' && audioIdx.length) {
    const k = opts.audio === 'mix' ? audioIdx[0] : Math.min(Number(opts.audio || 0), n - 1);
    if (ins[k] && ins[k].info.hasAudio) amap = ['-map', `${k}:a`];
  }
  const out = path.join(work, `${base}.mp4`);
  await ffmpeg([...args, '-filter_complex', parts.join(';'), '-map', '[v]', ...amap,
    ...(opts.duration === 'longest' ? [] : ['-shortest']), ...enc('mp4', { audio: amap.length > 0 }), out]);
  return [out];
}

async function freeze({ inputs, opts, work, base }) {
  const input = inputs[0];
  const info = input.info;
  const t = Math.min(parseTime(opts.time, 0), Math.max(0, info.duration - 0.05));
  const d = num(opts.duration, 2, 0.1, 60);
  const e = outExt(input, opts.format);
  const out = path.join(work, `${base}.${e}`);
  const parts = [
    `[0:v]split[va][vb]`,
    `[va]trim=end=${t},setpts=PTS-STARTPTS[v1]`,
    `[vb]trim=start=${t},setpts=PTS-STARTPTS,tpad=start_duration=${d}:start_mode=clone[v2]`,
  ];
  const sound = info.hasAudio && opts.sound !== 'mute';
  if (sound) {
    parts.push(`[0:a]asplit[aa][ab]`, `[aa]atrim=end=${t},asetpts=PTS-STARTPTS[a1]`,
      `[ab]atrim=start=${t},asetpts=PTS-STARTPTS,adelay=${Math.round(d * 1000)}:all=1[a2]`,
      `[v1][a1][v2][a2]concat=n=2:v=1:a=1[v][a]`);
  } else {
    parts.push(`[v1][v2]concat=n=2:v=1:a=0[v]`);
  }
  if (t <= 0.01) {
    // freeze the very first frame: no leading segment
    const fc = `[0:v]tpad=start_duration=${d}:start_mode=clone[v]` + (sound ? `;[0:a]adelay=${Math.round(d * 1000)}:all=1[a]` : '');
    await ffmpeg(['-i', input.path, '-filter_complex', fc, '-map', '[v]', ...(sound ? ['-map', '[a]'] : []), ...enc(e, { audio: sound }), out]);
    return [out];
  }
  await ffmpeg(['-i', input.path, '-filter_complex', parts.join(';'), '-map', '[v]', ...(sound ? ['-map', '[a]'] : []), ...enc(e, { audio: sound }), out]);
  return [out];
}

const interpolate = (ctx) => {
  const fps = num(ctx.opts.fps, 60, 2, 120);
  const mode = ctx.opts.mode || 'mci';
  const filter = mode === 'blend' ? `framerate=fps=${fps}` : mode === 'dup' ? `fps=${fps}` : `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`;
  return vf(ctx, `${filter},scale=trunc(iw/2)*2:trunc(ih/2)*2`);
};

const aspect = (ctx) => {
  const { opts, inputs } = ctx;
  const info = inputs[0].info;
  let ratio = String(opts.ratio || '16:9');
  if (ratio === 'custom') ratio = String(opts.custom || '');
  const m = ratio.match(/^\s*([\d.]+)\s*[:x/]\s*([\d.]+)\s*$/);
  if (!m) throw new Error('Enter a ratio like 16:9.');
  const r = parseFloat(m[1]) / parseFloat(m[2]);
  const cur = info.width / info.height;
  let W, H;
  const mode = opts.mode || 'pad';
  if (mode === 'crop') {
    if (r > cur) { W = info.width; H = info.width / r; } else { H = info.height; W = info.height * r; }
    return vf(ctx, `crop=${even(W)}:${even(H)},setsar=1`);
  }
  if (mode === 'stretch') {
    if (r > cur) { H = info.height; W = H * r; } else { W = info.width; H = W / r; }
    return vf(ctx, `scale=${even(W)}:${even(H)},setsar=1`);
  }
  if (r > cur) { H = info.height; W = H * r; } else { W = info.width; H = W / r; }
  W = even(W); H = even(H);
  if (mode === 'blur') {
    return vfComplex(ctx, `[0:v]split[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=30[bg];[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]`);
  }
  return vf(ctx, `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${opts.color || 'black'},setsar=1`);
};

async function vfComplex({ inputs, opts, work, base }, fc) {
  const input = inputs[0];
  const e = outExt(input, opts.format);
  const out = path.join(work, `${base}.${e}`);
  await ffmpeg(['-i', input.path, '-filter_complex', fc, '-map', '[v]', '-map', '0:a?', ...enc(e, { audio: input.info.hasAudio }), out]);
  return [out];
}

async function frames({ inputs, opts, work, base }, fmt) {
  const input = inputs[0];
  const info = input.info;
  const t = trimArgs(opts, info);
  const dir = path.join(work, 'frames');
  fs.mkdirSync(dir, { recursive: true });
  const maxFrames = Math.round(num(opts.max, 300, 1, 2000));
  const vfParts = [];
  if (opts.fps && opts.fps !== 'all') vfParts.push(`fps=${num(opts.fps, 5, 0.01, 60)}`);
  if (opts.width && Number(opts.width) > 0) vfParts.push(`scale=${Math.round(Number(opts.width))}:-1:flags=lanczos`);
  const ext = fmt === 'jpg' ? 'jpg' : 'png';
  const q = fmt === 'jpg' ? ['-q:v', String(Math.round(31 - (num(opts.quality, 90, 1, 100) / 100) * 29))] : [];
  await ffmpeg([...t, '-i', input.path, ...(vfParts.length ? ['-vf', vfParts.join(',')] : []), '-frames:v', String(maxFrames), ...q,
    path.join(dir, `${base}-%04d.${ext}`)]);
  const files = listFiles(dir, new RegExp(`\\.${ext}$`));
  if (!files.length) throw new Error('No frames were extracted. Check the start/end times.');
  return files;
}

async function screenshot({ inputs, opts, work, base }) {
  const input = inputs[0];
  const t = Math.min(parseTime(opts.time, 0), Math.max(0, input.info.duration - 0.05));
  const ext = opts.format === 'jpg' ? 'jpg' : opts.format === 'webp' ? 'webp' : 'png';
  const png = path.join(work, `${base}-${t.toFixed(2).replace('.', '_')}s.png`);
  await ffmpeg(['-ss', String(t), '-i', input.path, '-frames:v', '1', png]);
  if (ext === 'png') return [png];
  const out = png.replace(/\.png$/, `.${ext}`);
  await sharp(png)[ext === 'jpg' ? 'jpeg' : 'webp']({ quality: 92 }).toFile(out);
  fs.unlinkSync(png);
  return [out];
}

async function imagesToVideo({ inputs, opts, work, base }) {
  if (!inputs.length) throw new Error('Upload some images.');
  const dur = num(opts.duration, 2, 0.1, 60);
  const fps = 30;
  let W = num(opts.width, 0, 0, 3840);
  let H = num(opts.height, 0, 0, 3840);
  const prepDir = path.join(work, 'prep');
  fs.mkdirSync(prepDir, { recursive: true });
  // Normalize every image to PNG (handles webp/avif/svg/gif/bmp/heic etc.)
  const imgs = [];
  for (let k = 0; k < inputs.length; k++) {
    const p = path.join(prepDir, `${k}.png`);
    await require('./images').toPng(inputs[k], p);
    imgs.push(p);
  }
  if (!W || !H) {
    const m = await sharp(imgs[0]).metadata();
    W = W || m.width; H = H || m.height;
  }
  W = even(Math.min(W, 3840)); H = even(Math.min(H, 3840));
  const fade = opts.transition === 'fade' ? Math.min(0.5, dur / 3) : 0;
  const args = [];
  const parts = [];
  imgs.forEach((p, k) => {
    args.push('-loop', '1', '-t', String(dur), '-i', p);
    const fit = opts.fit === 'crop'
      ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${opts.color || 'black'}`;
    const fades = fade ? `,fade=t=in:st=0:d=${fade},fade=t=out:st=${dur - fade}:d=${fade}` : '';
    parts.push(`[${k}:v]${fit},setsar=1,fps=${fps},format=yuv420p${fades}[v${k}]`);
  });
  parts.push(`${imgs.map((_, k) => `[v${k}]`).join('')}concat=n=${imgs.length}:v=1:a=0[v]`);
  const e = VIDEO_OUT.includes(opts.format) ? opts.format : 'mp4';
  const out = path.join(work, `${base}.${e}`);
  await ffmpeg([...args, '-filter_complex', parts.join(';'), '-map', '[v]', ...enc(e, { audio: false }), out]);
  return [out];
}

async function convert({ inputs, opts, work, base }) {
  const input = inputs[0];
  const info = input.info;
  const e = VIDEO_OUT.includes(opts.format) ? opts.format : 'mp4';
  const out = path.join(work, `${base}.${e}`);
  const f = [];
  if (opts.autocrop) {
    const res = await new Promise((resolve) => {
      const { spawn } = require('child_process');
      const p = spawn('ffmpeg', ['-hide_banner', '-i', input.path, '-t', String(Math.min(60, info.duration || 60)), '-vf', 'cropdetect=24:2:0', '-f', 'null', '-']);
      let s = '';
      p.stderr.on('data', (d) => (s += d));
      p.on('close', () => resolve(s));
    });
    const all = [...res.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)].map((m) => m[1]);
    if (all.length) {
      const counts = {};
      all.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
      f.push(`crop=${Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]}`);
    }
  }
  if (opts.ratio && opts.ratio !== 'none') {
    const [a, b] = opts.ratio.split(':').map(Number);
    f.push(`crop='if(gt(iw/ih,${a}/${b}),ih*${a}/${b},iw)':'if(gt(iw/ih,${a}/${b}),ih,iw*${b}/${a})'`);
  }
  f.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  const crfMap = { high: e === 'webm' ? 28 : 18, medium: e === 'webm' ? 33 : 23, low: e === 'webm' ? 40 : 28 };
  await ffmpeg(['-i', input.path, '-vf', f.join(','), ...enc(e, { audio: info.hasAudio, crf: crfMap[opts.quality] ?? undefined }), out]);
  return [out];
}

module.exports = {
  'video-to-gif': (c) => toAnim(c, 'gif'),
  'video-to-webp': (c) => toAnim(c, 'webp'),
  'video-to-apng': (c) => toAnim(c, 'apng'),
  'video-to-avif': (c) => toAnim(c, 'avif'),
  'resize-video': resize,
  'crop-video': crop,
  'rotate-video': rotate,
  'reverse-video': reverse,
  'loop-video': loop,
  'cut-video': cut,
  'video-filters': filters,
  'video-speed': speed,
  'watermark-video': watermark,
  'merge-videos': merge,
  'video-mixer': mixer,
  'freeze-video': freeze,
  'interpolate-frames': interpolate,
  'change-aspect-ratio': aspect,
  'video-to-jpg': (c) => frames(c, 'jpg'),
  'video-to-png': (c) => frames(c, 'png'),
  'images-to-video': imagesToVideo,
  'video-screenshot': screenshot,
  'video-converter': convert,
  probe,
};
