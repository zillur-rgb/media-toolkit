<script setup>
import { ref, computed, onMounted } from 'vue';
import { resolveLink } from './api.js';
import MediaCard from './components/MediaCard.vue';
import ProfileView from './components/ProfileView.vue';
import PostHeader from './components/PostHeader.vue';

const TABS = [
  { id: 'video', label: 'Video', hint: 'https://www.instagram.com/p/…' },
  { id: 'photo', label: 'Photo', hint: 'https://www.instagram.com/p/…' },
  { id: 'reels', label: 'Reels', hint: 'https://www.instagram.com/reel/…' },
  { id: 'story', label: 'Story', hint: 'https://www.instagram.com/stories/username/…' },
  { id: 'carousel', label: 'Carousel', hint: 'https://www.instagram.com/p/…' },
  { id: 'profile', label: 'Profile', hint: '@username or https://www.instagram.com/username/' },
];

const tab = ref('video');
const link = ref('');
const loading = ref(false);
const error = ref('');
const result = ref(null);
const loggedIn = ref(false);

const placeholder = computed(() => `Paste Instagram ${TABS.find((t) => t.id === tab.value).label.toLowerCase()} link — ${TABS.find((t) => t.id === tab.value).hint}`);

async function submit(pushHistory = true) {
  const url = link.value.trim();
  if (!url) return;
  error.value = '';
  result.value = null;
  loading.value = true;
  if (pushHistory) history.pushState(null, '', `?url=${encodeURIComponent(url)}`);
  try {
    result.value = await resolveLink(url);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function paste() {
  try {
    link.value = (await navigator.clipboard.readText()).trim();
    if (link.value) submit();
  } catch {
    error.value = 'Your browser blocked clipboard access — paste with Ctrl/⌘+V instead.';
  }
}

function clear() {
  link.value = '';
  result.value = null;
  error.value = '';
  history.pushState(null, '', location.pathname);
}

function openPost(shortcode) {
  link.value = `https://www.instagram.com/p/${shortcode}/`;
  submit();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function downloadAll() {
  // Trigger the downloads one after another so the browser doesn't block them
  result.value.items.forEach((it, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = `/api/ig/media?u=${encodeURIComponent(it.url)}&dl=1&name=${encodeURIComponent(it.name)}`;
      a.download = it.name;
      document.body.append(a);
      a.click();
      a.remove();
    }, i * 700);
  });
}

function loadFromQuery() {
  const u = new URLSearchParams(location.search).get('url');
  link.value = u || '';
  if (u) submit(false);
  else result.value = null;
}

onMounted(() => {
  loadFromQuery();
  window.addEventListener('popstate', loadFromQuery);
  fetch('/api/ig/status').then((r) => r.json()).then((s) => (loggedIn.value = s.logged_in)).catch(() => {});
});
</script>

<template>
  <header class="topbar">
    <a class="brand" href="/">
      <span class="logo"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" /><path d="M11 9l12 7-12 7z" /></svg></span>
      <span>Media<b>Kit</b></span>
    </a>
    <nav class="cats">
      <a href="/video/video-to-gif">Video tools</a>
      <a href="/pdf/crop-pdf">PDF tools</a>
      <a href="/instagram/" class="active">Instagram</a>
    </nav>
  </header>

  <main class="ig">
    <section class="ig-hero">
      <h1>Instagram downloader</h1>
      <p class="desc">Download videos, photos, reels, carousels and profile pictures from public Instagram accounts.</p>

      <div class="ig-tabs" role="tablist">
        <button v-for="t in TABS" :key="t.id" role="tab" :aria-selected="tab === t.id" :class="{ on: tab === t.id }" @click="tab = t.id">
          {{ t.label }}
        </button>
      </div>

      <form class="ig-form" @submit.prevent="submit()">
        <div class="ig-input">
          <input v-model="link" type="text" :placeholder="placeholder" autocomplete="off" spellcheck="false" aria-label="Instagram link" />
          <button v-if="link" type="button" class="ig-x" aria-label="Clear" @click="clear">✕</button>
          <button v-else type="button" class="ig-paste" @click="paste">Paste</button>
        </div>
        <button class="btn primary" type="submit" :disabled="loading">
          <span v-if="loading" class="spinner"></span>{{ loading ? 'Loading…' : 'Download' }}
        </button>
      </form>
      <p v-if="tab === 'story' && !loggedIn" class="note ig-note">
        Stories and highlights are only visible to logged-in Instagram users, so the server needs an Instagram session for them (see README).
      </p>
      <div v-if="error" class="error">{{ error }}</div>
    </section>

    <section v-if="loading" class="ig-skeleton">
      <div class="sk" v-for="n in 3" :key="n"></div>
    </section>

    <template v-if="result && !loading">
      <ProfileView v-if="result.type === 'profile'" :data="result" @open="openPost" />
      <section v-else class="card">
        <PostHeader :data="result" />
        <div class="ig-bar" v-if="result.items.length > 1">
          <span class="status">{{ result.items.length }} items</span>
          <button class="btn sm" @click="downloadAll">⬇ Download all</button>
        </div>
        <div class="ig-grid" :class="{ single: result.items.length === 1 }">
          <MediaCard v-for="(it, i) in result.items" :key="it.url" :item="it" :index="result.items.length > 1 ? i + 1 : 0" />
        </div>
      </section>
    </template>

    <section v-if="!result && !loading" class="ig-how">
      <h2>How to download</h2>
      <ol>
        <li>Open the post, reel or profile in Instagram and copy its link (<b>⋯ → Copy link</b> or <b>Share → Copy link</b>).</li>
        <li>Paste the link above and press <b>Download</b>.</li>
        <li>Preview the media and save it with the download button. Carousels can be saved all at once.</li>
      </ol>
      <p class="status">Only public content can be downloaded. Respect creators' rights — download only content you have permission to use.</p>
    </section>
  </main>
  <footer class="foot">MediaKit · Not affiliated with Instagram or Meta.</footer>
</template>
