<script setup lang="ts">
import { ApiError } from '../lib/api';
import RadarIcon from './RadarIcon.vue';
defineProps<{ loading?: boolean; error?: Error | null; empty?: boolean; emptyText?: string }>();
defineEmits<{ retry: [] }>();
</script>
<template>
  <div v-if="loading" class="data-state" role="status">
    <span class="loading-ring" /><strong>正在读取信号</strong><span>获取最新可用数据…</span>
  </div>
  <div v-else-if="error" class="data-state error-state" role="alert">
    <RadarIcon name="warning" :size="28" /><strong>数据暂时不可用</strong
    ><span>{{ error.message }}</span
    ><code v-if="error instanceof ApiError && error.requestId">请求 ID：{{ error.requestId }}</code
    ><button class="btn" @click="$emit('retry')">
      <RadarIcon name="refresh" :size="15" />重新加载
    </button>
  </div>
  <div v-else-if="empty" class="data-state">
    <RadarIcon name="radar" :size="36" /><strong>{{ emptyText ?? '尚未发现符合条件的信号' }}</strong
    ><span>系统会在数据可用后更新，请检查数据源配置或调整筛选条件。</span>
  </div>
  <slot v-else />
</template>
