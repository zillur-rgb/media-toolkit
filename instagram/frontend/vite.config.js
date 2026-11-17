import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Served by the MediaKit Node server under /instagram/.
// In dev (`npm run dev`), API calls go to FastAPI and shared styles to MediaKit.
export default defineConfig({
  base: '/instagram/',
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api/ig': 'http://localhost:8001',
      '/style.css': 'http://localhost:4321',
    },
  },
});
