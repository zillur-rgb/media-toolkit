<script setup>
import { mediaUrl, downloadUrl, formatCount } from '../api.js';

defineProps({ data: { type: Object, required: true } });
defineEmits(['open']);
</script>

<template>
  <section class="card ig-profile">
    <div class="ig-profile-top">
      <img class="ig-avatar xl" :src="mediaUrl(data.owner.pic)" alt="Profile picture" />
      <div class="ig-profile-info">
        <h2>@{{ data.owner.username }} <span v-if="data.is_verified" title="Verified" class="ig-verified">✔</span></h2>
        <div v-if="data.owner.full_name" class="ig-fullname">{{ data.owner.full_name }}</div>
        <div class="ig-counts">
          <span v-if="data.posts_count != null"><b>{{ formatCount(data.posts_count) }}</b> posts</span>
          <span><b>{{ formatCount(data.followers) }}</b> followers</span>
          <span><b>{{ formatCount(data.following) }}</b> following</span>
        </div>
        <p v-if="data.bio" class="ig-bio">{{ data.bio }}</p>
        <a class="btn primary" :href="downloadUrl(data.items[0].url, data.items[0].name)">⬇ Download profile picture</a>
      </div>
    </div>
  </section>

  <section class="card">
    <h3>Recent posts</h3>
    <p v-if="data.is_private" class="note">This account is private, so its posts can't be downloaded.</p>
    <p v-else-if="!data.posts.length" class="status">No posts found.</p>
    <div v-else class="ig-posts">
      <button v-for="p in data.posts" :key="p.shortcode" class="ig-post" :title="p.caption" @click="$emit('open', p.shortcode)">
        <img :src="mediaUrl(p.thumb)" alt="" loading="lazy" />
        <span v-if="p.kind !== 'image'" class="ig-kind">{{ p.kind === 'video' ? '▶' : '❐' }}</span>
        <span class="ig-hover">Open &amp; download</span>
      </button>
    </div>
  </section>
</template>
