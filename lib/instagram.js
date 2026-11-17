// Mounts the Instagram downloader: Vue 3 build at /instagram, FastAPI backend proxied at /api/ig.
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'instagram');
const DIST = path.join(ROOT, 'frontend', 'dist');
const IG_PORT = Number(process.env.IG_PORT || 8001);
const IG_HOST = process.env.IG_HOST || '127.0.0.1';

/** Start the FastAPI backend as a child process (unless IG_EXTERNAL=1, e.g. you run it yourself). */
function startBackend() {
  if (process.env.IG_EXTERNAL === '1') return;
  const uvicorn = path.join(ROOT, 'backend', '.venv', 'bin', 'uvicorn');
  if (!fs.existsSync(uvicorn)) {
    console.warn('[instagram] backend venv missing — see README to set it up. /instagram will show errors.');
    return;
  }
  const child = spawn(uvicorn, ['app:app', '--host', IG_HOST, '--port', String(IG_PORT)], {
    cwd: path.join(ROOT, 'backend'),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  child.on('exit', (code) => code && console.warn(`[instagram] backend exited with code ${code}`));
  const stop = () => child.kill();
  process.on('exit', stop);
  ['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { stop(); process.exit(0); }));
}

/** Stream-proxy /api/ig/* to the Python service (keeps Range requests working for video seeking). */
function proxy(req, res) {
  const upstream = http.request(
    { host: IG_HOST, port: IG_PORT, path: req.originalUrl, method: req.method, headers: { ...req.headers, host: `${IG_HOST}:${IG_PORT}` } },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'The Instagram service is not running. Start the server again or check the README.' });
  });
  req.pipe(upstream);
  res.on('close', () => upstream.destroy());
}

function mount(app) {
  startBackend();
  app.use('/api/ig', proxy);
  app.use('/instagram', express.static(DIST));
  app.get(/^\/instagram(\/.*)?$/, (_req, res) => {
    const index = path.join(DIST, 'index.html');
    if (fs.existsSync(index)) res.sendFile(index);
    else res.status(503).send('Instagram frontend not built. Run: cd instagram/frontend && npm install && npm run build');
  });
}

module.exports = { mount };
