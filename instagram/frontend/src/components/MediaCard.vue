<script setup>
import { mediaUrl, downloadUrl } from '../api.js';

defineProps({
  item: { type: Object, required: true },
  index: { type: Number, default: 0 },
});
</script>

<template>
  <figure class="ig-card">
    <div class="ig-media">
      <video v-if="item.kind === 'video'" :src="mediaUrl(item.url)" :poster="item.thumb ? mediaUrl(item.thumb) : undefined" controls playsinline preload="metadata"></video>
      <img v-else :src="mediaUrl(item.url)" :alt="item.name" loading="lazy" />
      <span class="ig-badge">{{ index ? `${index} · ` : '' }}{{ item.kind === 'video' ? 'Video' : 'Photo' }}</span>
    </div>
    <figcaption>
      <a class="btn primary ig-dl" :href="downloadUrl(item.url, item.name)" :download="item.name">
        ⬇ Download {{ item.kind === 'video' ? 'video' : 'photo' }}
      </a>
      <a v-if="item.kind === 'video' && item.thumb" class="btn sm" :href="downloadUrl(item.thumb, item.name.replace(/\.mp4$/, '_cover.jpg'))">Cover image</a>
    </figcaption>
  </figure>
</template>
