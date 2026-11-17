# MediaKit: Node (Express) + Python (FastAPI) + ffmpeg/poppler in one container.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg poppler-utils ghostscript imagemagick libheif-examples \
      python3 python3-venv unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python backend for the Instagram downloader (lib/instagram.js expects instagram/backend/.venv)
COPY instagram/backend/requirements.txt instagram/backend/
RUN python3 -m venv instagram/backend/.venv \
    && instagram/backend/.venv/bin/pip install --no-cache-dir -r instagram/backend/requirements.txt

# Node dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Vue frontend build
COPY instagram/frontend/package.json instagram/frontend/package-lock.json instagram/frontend/
RUN cd instagram/frontend && npm ci
COPY . .
RUN cd instagram/frontend && npm run build && rm -rf node_modules

ENV NODE_ENV=production PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
