/* global TOOLS */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  };
  const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);
  const fmtTime = (s) => {
    s = Number(s) || 0;
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
  };
  const byId = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
  const CAT_LABEL = { video: 'Video tools', pdf: 'PDF tools' };

  // ---------- state ----------
  let state = null;

  // ---------- routing ----------
  function navigate(url, replace) {
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    render();
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    $('#sidebar').classList.remove('open');
    navigate(a.getAttribute('href'));
    window.scrollTo(0, 0);
  });
  window.addEventListener('popstate', render);
  $('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  function render() {
    const m = location.pathname.match(/^\/(video|pdf)\/([\w-]+)/);
    const tool = m && byId[m[2]];
    const cat = tool ? tool.cat : null;
    document.querySelectorAll('.cats a').forEach((a) => a.classList.toggle('active', a.dataset.cat === cat));
    renderSidebar(cat || 'video', tool);
    if (tool) renderTool(tool);
    else renderHome();
  }

  function renderSidebar(cat, active) {
    const sb = $('#sidebar');
    sb.innerHTML = '';
    const cats = cat ? [cat] : ['video', 'pdf'];
    for (const c of cats) {
      const groups = {};
      TOOLS.filter((t) => t.cat === c).forEach((t) => (groups[t.group] = groups[t.group] || []).push(t));
      for (const [g, list] of Object.entries(groups)) {
        sb.append(h('h4', {}, g));
        list.forEach((t) => sb.append(h('a', { href: `/${t.cat}/${t.id}`, 'data-link': true, class: active && active.id === t.id ? 'active' : '' }, t.nav)));
      }
    }
    const other = cat === 'video' ? 'pdf' : 'video';
    sb.append(h('h4', {}, 'More'), h('a', { href: `/${other}/${TOOLS.find((t) => t.cat === other).id}`, 'data-link': true }, `${CAT_LABEL[other]} →`));
  }

  function renderHome() {
    document.title = 'MediaKit — video & PDF tools';
    const main = $('#main');
    main.innerHTML = '';
    main.append(h('div', { class: 'hero' }, h('h1', {}, 'Video & PDF tools'),
      h('p', { class: 'desc' }, 'Convert, cut, crop, resize, merge and edit videos and PDFs. Upload a file, pick options, download the result — or pass it on to another tool.')));
    for (const c of ['video', 'pdf']) {
      const groups = {};
      TOOLS.filter((t) => t.cat === c).forEach((t) => (groups[t.group] = groups[t.group] || []).push(t));
      main.append(h('h2', {}, CAT_LABEL[c]));
      for (const [g, list] of Object.entries(groups)) {
        main.append(h('div', { class: 'section-title' }, g));
        main.append(h('div', { class: 'grid' }, list.map((t) => h('a', { class: 'tile', href: `/${t.cat}/${t.id}`, 'data-link': true }, h('b', {}, t.title), h('span', {}, t.desc)))));
      }
    }
  }

  // ---------- API ----------
  async function api(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: `Server error (${r.status})` }));
    if (!r.ok) throw new Error(j.error || `Server error (${r.status})`);
    return j;
  }
  function uploadFiles(files, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      [...files].forEach((f) => fd.append('files', f));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let j = {};
        try { j = JSON.parse(xhr.responseText); } catch { /* */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(j.files);
        else reject(new Error(j.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed — network error.'));
      xhr.send(fd);
    });
  }

  // ---------- tool page ----------
  function acceptsFile(tool, meta) {
    const ext = '.' + meta.name.split('.').pop().toLowerCase();
    return tool.accept.split(',').includes(ext);
  }

  async function renderTool(tool) {
    document.title = `${tool.title} — MediaKit`;
    const params = new URLSearchParams(location.search);
    state = { tool, files: [], secondary: null, opts: {}, results: null, busy: false };
    const main = $('#main');
    main.innerHTML = '';
    main.append(h('h1', {}, tool.title), h('p', { class: 'desc' }, tool.desc));
    const uploadCard = h('div', { id: 'uploadCard' });
    const workCard = h('div', { id: 'work' });
    const resultCard = h('div', { id: 'results' });
    main.append(uploadCard, workCard, resultCard);

    const ids = (params.get('file') || '').split(',').filter(Boolean);
    if (ids.length) {
      try {
        const metas = await Promise.all(ids.map((id) => fetch(`/api/file/${id}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('expired'))))));
        if (state.tool !== tool) return;
        state.files = metas.filter((m) => acceptsFile(tool, m));
      } catch {
        /* expired: show uploader */
      }
    }
    drawUploader();
    drawWork();
  }

  function drawUploader() {
    const tool = state.tool;
    const card = $('#uploadCard');
    card.innerHTML = '';
    if (state.files.length && !tool.multi) {
      card.append(h('div', { class: 'card' }, h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap' },
        h('div', {}, h('b', {}, state.files[0].name), h('span', { class: 'status' }, `  ·  ${fmtSize(state.files[0].size)}${describe(state.files[0])}`)),
        h('button', { class: 'btn sm', onclick: () => { state.files = []; state.results = null; history.replaceState(null, '', location.pathname); drawUploader(); drawWork(); $('#results').innerHTML = ''; } }, 'Choose another file'))));
      return;
    }
    const input = h('input', { type: 'file', accept: tool.accept, multiple: tool.multi ? true : null, hidden: true });
    const bar = h('div', { class: 'progress', hidden: true }, h('div'));
    const err = h('div');
    const exts = tool.accept.split(',').map((e) => e.slice(1).toUpperCase()).filter((v, i, a) => a.indexOf(v) === i);
    const drop = h('div', { class: 'drop', onclick: () => input.click() },
      h('div', { class: 'big' }, tool.multi ? (state.files.length ? 'Add more files' : 'Choose files or drop them here') : 'Choose a file or drop it here'),
      h('div', { class: 'small' }, `${exts.slice(0, 14).join(', ')}${exts.length > 14 ? '…' : ''} · up to 500 MB`));
    const doUpload = async (files) => {
      files = [...files];
      if (!files.length) return;
      err.innerHTML = '';
      bar.hidden = false;
      try {
        const metas = await uploadFiles(tool.multi ? files : files.slice(0, 1), (p) => (bar.firstChild.style.width = `${p * 100}%`));
        const bad = metas.filter((m) => !acceptsFile(tool, m));
        state.files = tool.multi ? [...state.files, ...metas.filter((m) => acceptsFile(tool, m))] : metas.filter((m) => acceptsFile(tool, m)).slice(0, 1);
        if (bad.length) err.append(h('div', { class: 'error' }, `Not supported by this tool: ${bad.map((b) => b.name).join(', ')}`));
        if (!tool.multi && state.files[0]) history.replaceState(null, '', `${location.pathname}?file=${state.files[0].id}`);
        drawUploader();
        if (bad.length) $('#uploadCard').append(err);
        drawWork();
      } catch (e) {
        bar.hidden = true;
        err.append(h('div', { class: 'error' }, e.message));
      }
    };
    input.addEventListener('change', () => doUpload(input.files));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); doUpload(e.dataTransfer.files); });

    const urlIn = h('input', { type: 'url', placeholder: 'Or paste a direct file URL (https://…)' });
    const urlBtn = h('button', { class: 'btn', onclick: async () => {
      if (!urlIn.value.trim()) return;
      err.innerHTML = '';
      urlBtn.disabled = true;
      urlBtn.textContent = 'Fetching…';
      try {
        const { files } = await api('/api/upload-url', { url: urlIn.value.trim() });
        if (!acceptsFile(tool, files[0])) throw new Error(`This tool does not accept ${files[0].name}`);
        state.files = tool.multi ? [...state.files, ...files] : files;
        if (!tool.multi) history.replaceState(null, '', `${location.pathname}?file=${files[0].id}`);
        drawUploader();
        drawWork();
      } catch (e) {
        err.append(h('div', { class: 'error' }, e.message));
      } finally {
        urlBtn.disabled = false;
        urlBtn.textContent = 'Upload';
      }
    } }, 'Upload');
    card.append(h('div', { class: 'card' }, drop, input, h('div', { class: 'url-row' }, urlIn, urlBtn), bar, err));
  }

  function describe(m) {
    const i = m.info || {};
    if (i.error) return '';
    if (m.kind === 'pdf') return `  ·  ${i.pages} page${i.pages === 1 ? '' : 's'}`;
    const parts = [];
    if (i.width) parts.push(`${i.width}×${i.height}`);
    if (i.duration) parts.push(fmtTime(i.duration));
    if (i.fps) parts.push(`${i.fps} fps`);
    if (m.kind === 'video' && i.hasAudio === false) parts.push('no audio');
    return parts.length ? `  ·  ${parts.join(' · ')}` : '';
  }

  function thumbFor(m) {
    if (m.kind === 'pdf') return h('img', { class: 'thumb', src: `/api/pdf-thumb/${m.id}?w=200`, alt: '' });
    if (m.kind === 'image' || m.kind === 'gif') return h('img', { class: 'thumb', src: m.url, alt: '', onerror: (e) => (e.target.style.visibility = 'hidden') });
    if (m.kind === 'video') return h('video', { class: 'thumb', src: `${m.url}#t=0.5`, muted: true, preload: 'metadata' });
    return h('div', { class: 'thumb' });
  }

  // ---------- work area: file list / preview + options ----------
  function drawWork() {
    const work = $('#work');
    work.innerHTML = '';
    const tool = state.tool;
    state.player = null;
    if (!state.files.length) return;

    if (tool.multi) {
      const list = h('ul', { class: 'files' });
      let dragIdx = null;
      state.files.forEach((m, i) => {
        const li = h('li', { draggable: 'true' },
          h('span', { class: 'handle', title: 'Drag to reorder' }, '⋮⋮'), thumbFor(m),
          h('div', { class: 'meta' }, h('div', { class: 'name' }, `${i + 1}. ${m.name}`), h('div', { class: 'sub' }, fmtSize(m.size) + describe(m))),
          h('button', { class: 'btn sm ghost', title: 'Move up', onclick: () => move(i, i - 1) }, '↑'),
          h('button', { class: 'btn sm ghost', title: 'Move down', onclick: () => move(i, i + 1) }, '↓'),
          h('button', { class: 'btn sm ghost', title: 'Remove', onclick: () => { state.files.splice(i, 1); drawUploader(); drawWork(); } }, '✕'));
        li.addEventListener('dragstart', () => { dragIdx = i; li.classList.add('dragging'); });
        li.addEventListener('dragend', () => li.classList.remove('dragging'));
        li.addEventListener('dragover', (e) => e.preventDefault());
        li.addEventListener('drop', (e) => { e.preventDefault(); if (dragIdx !== null) move(dragIdx, i); });
        list.append(li);
      });
      const move = (a, b) => {
        if (b < 0 || b >= state.files.length) return;
        const [x] = state.files.splice(a, 1);
        state.files.splice(b, 0, x);
        drawWork();
      };
      work.append(h('div', { class: 'card' }, h('h3', {}, `${state.files.length} file${state.files.length > 1 ? 's' : ''} — drag to reorder`), list));
    } else {
      work.append(drawPreview(state.files[0]));
    }
    work.append(drawOptions());
  }

  function drawPreview(m) {
    const tool = state.tool;
    const card = h('div', { class: 'card preview' });
    const info = h('div', { class: 'info-line' }, `${m.name} · ${fmtSize(m.size)}${describe(m)}`);
    if (m.kind === 'video' || m.kind === 'gif') {
      let media;
      if (m.kind === 'gif') media = h('img', { src: m.url, alt: '' });
      else media = h('video', { src: m.url, controls: true, preload: 'auto', playsinline: true });
      const stage = h('div', { class: 'stage' }, media);
      card.append(stage, info);
      state.player = m.kind === 'video' ? media : null;
      if (tool.ui === 'crop') setupCrop(stage, media, m, 'video');
      if ((tool.ui === 'trim' || tool.ui === 'time') && state.player) {
        const tools = h('div', { class: 'player-tools' });
        const cur = h('span', { class: 'status' }, 'Current: 0:00.00');
        media.addEventListener('timeupdate', () => (cur.textContent = `Current: ${fmtTime(media.currentTime)}`));
        const step = (d) => { media.pause(); media.currentTime = Math.max(0, media.currentTime + d); };
        tools.append(h('button', { class: 'btn sm', onclick: () => step(-1 / (m.info.fps || 30)) }, '◀ frame'),
          h('button', { class: 'btn sm', onclick: () => step(1 / (m.info.fps || 30)) }, 'frame ▶'), cur);
        if (tool.ui === 'trim') {
          tools.append(h('button', { class: 'btn sm', onclick: () => setField('start', media.currentTime.toFixed(2)) }, 'Set as start'),
            h('button', { class: 'btn sm', onclick: () => setField('end', media.currentTime.toFixed(2)) }, 'Set as end'));
        } else {
          tools.append(h('button', { class: 'btn sm', onclick: () => setField('time', media.currentTime.toFixed(3)) }, 'Use current time'));
        }
        card.append(tools);
      }
    } else if (m.kind === 'pdf') {
      const pages = (m.info && m.info.pages) || 1;
      let page = 1;
      const img = h('img', { src: `/api/pdf-thumb/${m.id}?page=1&w=900`, alt: 'Page preview' });
      const stage = h('div', { class: 'stage' }, img);
      const label = h('span', {}, `Page 1 of ${pages}`);
      const go = (d) => { page = Math.min(pages, Math.max(1, page + d)); img.src = `/api/pdf-thumb/${m.id}?page=${page}&w=900`; label.textContent = `Page ${page} of ${pages}`; };
      card.append(stage, h('div', { class: 'pager' }, h('button', { class: 'btn sm', onclick: () => go(-1) }, '‹ Prev'), label, h('button', { class: 'btn sm', onclick: () => go(1) }, 'Next ›')), info);
      if (tool.ui === 'pdfcrop') setupCrop(stage, img, m, 'pdf');
    } else if (m.kind === 'image') {
      card.append(h('div', { class: 'stage' }, h('img', { src: m.url, alt: '' })), info);
    } else {
      card.append(info);
    }
    return card;
  }

  // ---------- crop overlay ----------
  function setupCrop(stage, media, m, mode) {
    const overlay = h('div', { class: 'overlay' });
    const sel = h('div', { class: 'sel', hidden: true }, ...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((d) => h('div', { class: 'h', 'data-h': d })));
    overlay.append(sel);
    stage.append(overlay);
    if (mode === 'video') media.controls = false;
    let r = null; // selection in displayed pixels {x,y,w,h}
    const dims = () => ({ W: overlay.clientWidth, H: overlay.clientHeight });
    const natural = () => {
      if (mode === 'video') return { w: m.info.width || media.videoWidth, h: m.info.height || media.videoHeight };
      return { w: media.naturalWidth, h: media.naturalHeight };
    };
    const aspect = () => {
      const a = state.opts.aspect;
      if (!a || a === 'free') return null;
      const [x, y] = a.split(':').map(Number);
      const n = natural();
      const { W, H } = dims();
      // ratio in display space (account for non-uniform scaling, should be ~uniform)
      return (x / y) * (W / n.w) / (H / n.h);
    };
    const draw = () => {
      if (!r) { sel.hidden = true; return; }
      sel.hidden = false;
      Object.assign(sel.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    };
    const commit = () => {
      if (!r) return;
      const { W, H } = dims();
      const n = natural();
      if (mode === 'video') {
        const sx = n.w / W, sy = n.h / H;
        setField('x', Math.round(r.x * sx), true);
        setField('y', Math.round(r.y * sy), true);
        setField('w', Math.round(r.w * sx), true);
        setField('h', Math.round(r.h * sy), true);
      } else {
        setField('unit', 'percent', true);
        setField('left', ((r.x / W) * 100).toFixed(2), true);
        setField('top', ((r.y / H) * 100).toFixed(2), true);
        setField('right', (((W - r.x - r.w) / W) * 100).toFixed(2), true);
        setField('bottom', (((H - r.y - r.h) / H) * 100).toFixed(2), true);
      }
    };
    state.cropFromFields = () => {
      const { W, H } = dims();
      if (!W || !H) return;
      const n = natural();
      const o = state.opts;
      if (mode === 'video') {
        const sx = W / n.w, sy = H / n.h;
        const w = Number(o.w) || n.w, hh = Number(o.h) || n.h;
        r = { x: (Number(o.x) || 0) * sx, y: (Number(o.y) || 0) * sy, w: w * sx, h: hh * sy };
      } else {
        if (o.unit && o.unit !== 'percent') return;
        const l = (Number(o.left) || 0) / 100, t = (Number(o.top) || 0) / 100, rr = (Number(o.right) || 0) / 100, b = (Number(o.bottom) || 0) / 100;
        r = { x: l * W, y: t * H, w: (1 - l - rr) * W, h: (1 - t - b) * H };
      }
      draw();
    };
    state.applyAspect = () => {
      const a = aspect();
      const { W, H } = dims();
      if (!a) return;
      if (!r) r = { x: 0, y: 0, w: W, h: H };
      let w = r.w, hh = w / a;
      if (hh > H) { hh = H; w = hh * a; }
      if (w > W) { w = W; hh = w / a; }
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      r = { w, h: hh, x: Math.min(W - w, Math.max(0, cx - w / 2)), y: Math.min(H - hh, Math.max(0, cy - hh / 2)) };
      draw();
      commit();
    };
    const ready = () => {
      const { W, H } = dims();
      if (!W) return;
      r = { x: 0, y: 0, w: W, h: H };
      if (mode === 'video') r = { x: W * 0.1, y: H * 0.1, w: W * 0.8, h: H * 0.8 };
      draw();
      commit();
    };
    if (mode === 'video') media.addEventListener('loadedmetadata', ready, { once: true });
    else media.addEventListener('load', () => { if (!r) ready(); else state.cropFromFields(); });
    new ResizeObserver(() => state.cropFromFields && r && state.cropFromFields()).observe(overlay);

    let drag = null;
    overlay.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      overlay.setPointerCapture(e.pointerId);
      const box = overlay.getBoundingClientRect();
      const p = { x: e.clientX - box.left, y: e.clientY - box.top };
      const handle = e.target.dataset && e.target.dataset.h;
      if (handle) drag = { type: 'resize', handle, start: p, r0: { ...r } };
      else if (e.target === sel) drag = { type: 'move', start: p, r0: { ...r } };
      else { drag = { type: 'new', start: p }; r = { x: p.x, y: p.y, w: 0, h: 0 }; }
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const box = overlay.getBoundingClientRect();
      const { W, H } = dims();
      const p = { x: Math.min(W, Math.max(0, e.clientX - box.left)), y: Math.min(H, Math.max(0, e.clientY - box.top)) };
      const a = aspect();
      if (drag.type === 'new') {
        let w = Math.abs(p.x - drag.start.x), hh = Math.abs(p.y - drag.start.y);
        if (a) { if (w / hh > a) w = hh * a; else hh = w / a; }
        r = { x: p.x < drag.start.x ? drag.start.x - w : drag.start.x, y: p.y < drag.start.y ? drag.start.y - hh : drag.start.y, w, h: hh };
      } else if (drag.type === 'move') {
        const r0 = drag.r0;
        r = { ...r0, x: Math.min(W - r0.w, Math.max(0, r0.x + p.x - drag.start.x)), y: Math.min(H - r0.h, Math.max(0, r0.y + p.y - drag.start.y)) };
      } else {
        const r0 = drag.r0;
        let x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h;
        const hd = drag.handle;
        if (hd.includes('w')) x1 = Math.min(p.x, x2 - 4);
        if (hd.includes('e')) x2 = Math.max(p.x, x1 + 4);
        if (hd.includes('n')) y1 = Math.min(p.y, y2 - 4);
        if (hd.includes('s')) y2 = Math.max(p.y, y1 + 4);
        if (a) {
          if (hd === 'n' || hd === 's') { const w = (y2 - y1) * a; x2 = x1 + w; }
          else { const hh = (x2 - x1) / a; if (hd.includes('n')) y1 = y2 - hh; else y2 = y1 + hh; }
        }
        r = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
      r.x = Math.max(0, r.x); r.y = Math.max(0, r.y);
      r.w = Math.min(r.w, W - r.x); r.h = Math.min(r.h, H - r.y);
      draw();
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      if (r && (r.w < 4 || r.h < 4)) ready();
      commit();
    };
    overlay.addEventListener('pointerup', end);
    overlay.addEventListener('pointercancel', end);
  }

  // ---------- options form ----------
  const fieldEls = {};
  function setField(key, value, silent) {
    state.opts[key] = value;
    const els = fieldEls[key] || [];
    els.forEach((el) => {
      if (el.type === 'checkbox') el.checked = !!value;
      else if (el.type === 'radio') el.checked = el.value === String(value);
      else el.value = value;
      if (el.type === 'range' && el.nextSibling) el.nextSibling.textContent = value;
    });
    if (!silent && state.cropFromFields) state.cropFromFields();
    updateVisibility();
  }

  function matches(cond) {
    return Object.entries(cond).every(([k, v]) => (Array.isArray(v) ? v.includes(state.opts[k]) : v === true ? !!state.opts[k] : String(state.opts[k] ?? '') === String(v)));
  }
  let visFns = [];
  function updateVisibility() {
    visFns.forEach((f) => f());
    drawSecondary();
  }

  function drawOptions() {
    const tool = state.tool;
    Object.keys(fieldEls).forEach((k) => delete fieldEls[k]);
    visFns = [];
    state.cropFromFields = state.cropFromFields || null;
    const form = h('div', { class: 'form' });
    const m = state.files[0];
    for (const f of tool.fields) {
      if (state.opts[f.key] === undefined) {
        let v = f.value ?? (f.type === 'checkbox' ? false : f.options ? f.options[0][0] : '');
        if (tool.ui === 'crop' && m && m.info) v = { x: 0, y: 0, w: m.info.width, h: m.info.height }[f.key] ?? v;
        if (f.key === 'end' && m && m.info && m.info.duration) v = Number(m.info.duration).toFixed(2);
        state.opts[f.key] = v;
      }
      if (f.type === 'hidden') continue;
      const field = h('div', { class: `field${f.type === 'checkbox' ? ' check' : ''}${f.type === 'textarea' ? ' wide' : ''}` });
      const reg = (el) => (fieldEls[f.key] = fieldEls[f.key] || []).push(el);
      const onChange = (v) => {
        state.opts[f.key] = v;
        if (f.key === 'aspect' && state.applyAspect) state.applyAspect();
        if (['x', 'y', 'w', 'h', 'top', 'left', 'right', 'bottom', 'unit'].includes(f.key) && state.cropFromFields) state.cropFromFields();
        updateVisibility();
      };
      if (f.type === 'checkbox') {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = !!state.opts[f.key];
        cb.addEventListener('change', () => onChange(cb.checked));
        reg(cb);
        field.append(h('label', {}, cb, f.label));
      } else {
        field.append(h('label', { class: 'lbl' }, f.label));
        if (f.type === 'select') {
          const s = h('select', {}, f.options.map(([v, l]) => h('option', { value: v }, l)));
          s.value = state.opts[f.key];
          s.addEventListener('change', () => onChange(s.value));
          reg(s);
          field.append(s);
        } else if (f.type === 'radio') {
          const seg = h('div', { class: 'seg' });
          const name = `r_${f.key}_${Math.random().toString(36).slice(2, 6)}`;
          f.options.forEach(([v, l]) => {
            const r = h('input', { type: 'radio', name, value: v });
            r.checked = String(state.opts[f.key]) === v;
            r.addEventListener('change', () => r.checked && onChange(v));
            reg(r);
            seg.append(h('label', {}, r, l));
          });
          field.append(seg);
        } else if (f.type === 'range') {
          const out = h('output', {}, state.opts[f.key]);
          const r = h('input', { type: 'range', min: f.min, max: f.max, step: f.step || 1, value: state.opts[f.key] });
          r.addEventListener('input', () => { out.textContent = r.value; onChange(r.value); });
          reg(r);
          field.append(h('div', { class: 'range-row' }, r, out));
        } else if (f.type === 'position') {
          const grid = h('div', { class: 'pos-grid' });
          const cells = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];
          const titles = ['Top left', 'Top center', 'Top right', 'Middle left', 'Center', 'Middle right', 'Bottom left', 'Bottom center', 'Bottom right'];
          const btns = cells.map((c, i) => h('button', { type: 'button', title: titles[i], class: state.opts[f.key] === c ? 'on' : '', onclick: () => {
            btns.forEach((b) => b.classList.remove('on'));
            btns[i].classList.add('on');
            onChange(c);
          } }));
          grid.append(...btns);
          field.append(grid);
        } else if (f.type === 'textarea') {
          const t = h('textarea', { placeholder: f.placeholder || '' });
          t.value = state.opts[f.key];
          t.addEventListener('input', () => onChange(t.value));
          reg(t);
          field.append(t);
        } else {
          const inp = h('input', { type: f.type === 'number' ? 'number' : f.type === 'color' ? 'color' : 'text', placeholder: f.placeholder || '', min: f.min, max: f.max, step: f.step || (f.type === 'number' ? 'any' : null) });
          inp.value = state.opts[f.key];
          inp.addEventListener('input', () => onChange(inp.value));
          reg(inp);
          if (f.type === 'time' && state.player) {
            field.append(h('div', { class: 'time-row' }, inp, h('button', { class: 'btn sm', type: 'button', title: 'Use the player’s current time', onclick: () => setField(f.key, state.player.currentTime.toFixed(2)) }, '⌖')));
          } else field.append(inp);
          if (f.presets) {
            field.append(h('div', { class: 'presets' }, f.presets.map((p) => h('button', { type: 'button', onclick: () => setField(f.key, p) }, `${p}×`))));
          }
        }
      }
      if (f.showIf || f.hideIf) {
        const fn = () => (field.hidden = (f.showIf && !matches(f.showIf)) || (f.hideIf && matches(f.hideIf)));
        visFns.push(fn);
        fn();
      }
      form.append(field);
    }
    const runBtn = h('button', { class: 'btn primary', onclick: runTool }, runLabel(tool));
    const status = h('span', { class: 'status', id: 'runStatus' });
    const card = h('div', { class: 'card' }, h('h3', {}, 'Options'));
    if (tool.id === 'eps-to-pdf') {
      fetch('/api/capabilities').then((r) => r.json()).then((c) => {
        if (!c.ghostscript) card.prepend(h('div', { class: 'note' }, 'EPS conversion needs Ghostscript on the server. Install it with “brew install ghostscript”, then restart the server.'));
      });
    }
    if (tool.fields.filter((f) => f.type !== 'hidden').length) card.append(form);
    else card.firstChild.textContent = 'Ready';
    card.append(h('div', { id: 'secondary' }), h('div', { class: 'actions' }, runBtn, status), h('div', { id: 'runError' }));
    state.runBtn = runBtn;
    setTimeout(updateVisibility);
    return card;
  }

  function runLabel(tool) {
    if (tool.id.includes('-to-')) return 'Convert';
    if (tool.id.startsWith('merge')) return 'Merge';
    if (tool.id === 'split-pdf') return 'Split';
    return 'Apply';
  }

  function drawSecondary() {
    const slot = $('#secondary');
    const sec = state.tool.secondary;
    if (!slot || !sec) return;
    const show = state.opts[sec.key] === sec.when;
    if (!show) { slot.innerHTML = ''; return; }
    if (slot.dataset.drawn === (state.secondary ? state.secondary.id : 'none')) return;
    slot.innerHTML = '';
    slot.dataset.drawn = state.secondary ? state.secondary.id : 'none';
    const input = h('input', { type: 'file', accept: sec.accept, hidden: true });
    const label = state.secondary
      ? h('span', { class: 'status' }, `${state.secondary.name} · ${fmtSize(state.secondary.size)}`)
      : h('span', { class: 'status' }, 'No image chosen');
    input.addEventListener('change', async () => {
      if (!input.files[0]) return;
      label.textContent = 'Uploading…';
      try {
        const [m] = await uploadFiles([input.files[0]], () => {});
        state.secondary = m;
        slot.dataset.drawn = '';
        drawSecondary();
      } catch (e) {
        label.textContent = e.message;
      }
    });
    slot.append(h('div', { style: 'margin-top:16px' }, h('label', { class: 'lbl', style: 'display:block;font-size:13px;font-weight:600;margin-bottom:6px' }, sec.label),
      h('div', { style: 'display:flex;gap:10px;align-items:center' },
        state.secondary ? h('img', { src: state.secondary.url, style: 'height:40px;border-radius:6px;background:var(--panel-2)' }) : null,
        h('button', { class: 'btn sm', type: 'button', onclick: () => input.click() }, state.secondary ? 'Change image' : 'Choose image'), label, input)));
  }

  // ---------- run ----------
  async function runTool() {
    if (state.busy) return;
    const tool = state.tool;
    const errBox = $('#runError');
    errBox.innerHTML = '';
    if (!state.files.length) return;
    const inputs = state.files.map((f) => f.id);
    if (tool.secondary && state.opts[tool.secondary.key] === tool.secondary.when) {
      if (!state.secondary) { errBox.append(h('div', { class: 'error' }, 'Choose a watermark image first.')); return; }
      inputs.push(state.secondary.id);
    }
    // Only send values of visible fields (two fields may share one key)
    const opts = {};
    for (const f of tool.fields) {
      if ((f.showIf && !matches(f.showIf)) || (f.hideIf && matches(f.hideIf)) || f.local) continue;
      opts[f.key] = state.opts[f.key];
    }
    state.busy = true;
    const btn = state.runBtn;
    const label = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '';
    btn.append(h('span', { class: 'spinner' }), ' Working…');
    const st = $('#runStatus');
    const t0 = Date.now();
    const timer = setInterval(() => (st.textContent = `${Math.round((Date.now() - t0) / 1000)} s`), 500);
    try {
      const res = await api('/api/process', { tool: tool.handler || tool.id, inputs, opts });
      showResults(res);
      st.textContent = `Done in ${(res.ms / 1000).toFixed(1)} s`;
    } catch (e) {
      errBox.append(h('div', { class: 'error' }, e.message));
      st.textContent = '';
    } finally {
      clearInterval(timer);
      state.busy = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function chainTargets(m) {
    const ext = '.' + m.name.split('.').pop().toLowerCase();
    return TOOLS.filter((t) => t.accept.split(',').includes(ext) && t.id !== state.tool.id);
  }

  function showResults(res) {
    const box = $('#results');
    box.innerHTML = '';
    const outs = res.outputs;
    const single = outs.length === 1;
    const grid = h('div', { class: `outs${single ? ' single' : ''}` });
    const shown = outs.slice(0, 120);
    for (const m of shown) {
      let media;
      if (m.kind === 'video') media = h('video', { src: m.url, controls: true, loop: true, autoplay: single, muted: single, playsinline: true });
      else if (m.kind === 'image' || m.kind === 'gif') media = h('img', { src: m.url, alt: m.name, loading: 'lazy' });
      else if (m.kind === 'pdf') media = h('img', { src: `/api/pdf-thumb/${m.id}?w=${single ? 900 : 400}`, alt: m.name, loading: 'lazy' });
      const stats = [fmtSize(m.size)];
      if (m.info && m.info.width) stats.push(`${m.info.width}×${m.info.height}`);
      if (m.info && m.info.duration && m.kind === 'video') stats.push(fmtTime(m.info.duration));
      if (m.kind === 'pdf' && m.info) stats.push(`${m.info.pages} page${m.info.pages === 1 ? '' : 's'}`);
      const statLine = h('div', { class: 'stats' }, stats.join(' · '));
      if (single && res.inputSize) {
        const pct = ((m.size - res.inputSize) / res.inputSize) * 100;
        statLine.append('  ·  ', h('span', { class: pct <= 0 ? 'gain' : 'loss' }, `${pct > 0 ? '+' : ''}${pct.toFixed(1)}% vs input`));
      }
      grid.append(h('div', { class: 'out' }, media ? h('div', { class: 'media' }, media) : null,
        h('div', { class: 'body' }, h('div', { class: 'name' }, m.name), statLine,
          h('div', { class: 'row' }, h('a', { class: 'btn sm', href: `${m.url}?dl=1` }, '⬇ Download'),
            m.kind === 'pdf' ? h('a', { class: 'btn sm', href: m.url, target: '_blank' }, 'Open') : null))));
    }
    const head = h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px' },
      h('h3', { style: 'margin:0' }, single ? 'Result' : `${outs.length} files`),
      res.zip ? h('a', { class: 'btn primary', href: `${res.zip.url}?dl=1` }, `⬇ Download all (ZIP, ${fmtSize(res.zip.size)})`) : null);
    const card = h('div', { class: 'card results' }, head, grid);
    if (outs.length > shown.length) card.append(h('p', { class: 'status' }, `Showing ${shown.length} of ${outs.length}. Download the ZIP for all files.`));
    if (single) {
      const targets = chainTargets(outs[0]);
      if (targets.length) {
        card.append(h('div', { class: 'chain' }, h('div', { class: 'label' }, 'Continue editing this result with:'),
          h('div', { class: 'chips' }, targets.map((t) => h('a', { href: `/${t.cat}/${t.id}?file=${outs[0].id}`, 'data-link': true }, t.nav)))));
      }
    }
    box.append(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  render();
})();
