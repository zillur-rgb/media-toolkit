<script setup>
import { computed, ref } from 'vue';
import { mediaUrl, formatCount } from '../api.js';

const props = defineProps({ data: { type: Object, required: true } });
const expanded = ref(false);
const kindLabel = computed(() => ({ reel: 'Reel', igtv: 'IGTV', carousel: 'Carousel', video: 'Video', photo: 'Photo' }[props.data.subtype] || (props.data.type === 'story' ? 'Story' : 'Post')));
const date = computed(() => (props.data.date ? new Date(props.data.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''));
const longCaption = computed(() => (props.data.caption || '').length > 220);
</script>

<template>
  <div class="ig-head">
    <img v-if="data.owner.pic" class="ig-avatar" :src="mediaUrl(data.owner.pic)" alt="" />
    <div v-else class="ig-avatar ig-avatar-empty">{{ (data.owner.username || '?')[0] }}</div>
    <div class="ig-who">
      <a :href="`/instagram/?url=${encodeURIComponent('@' + data.owner.username)}`"><b>@{{ data.owner.username }}</b></a>
      <span class="status">{{ kindLabel }}<template v-if="date"> · {{ date }}</template></span>
    </div>
    <div class="ig-stats">
      <span v-if="data.likes != null">♥ {{ formatCount(data.likes) }}</span>
      <span v-if="data.comments != null">💬 {{ formatCount(data.comments) }}</span>
      <span v-if="data.views">▶ {{ formatCount(data.views) }}</span>
    </div>
  </div>
  <p v-if="data.caption" class="ig-caption" :class="{ clamp: longCaption && !expanded }">{{ data.caption }}</p>
  <button v-if="longCaption" class="btn sm ghost" @click="expanded = !expanded">{{ expanded ? 'Show less' : 'Show full caption' }}</button>
</template>
