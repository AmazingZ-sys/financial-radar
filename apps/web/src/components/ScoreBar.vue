<script setup lang="ts">
import { number } from '../lib/format';
withDefaults(defineProps<{ value?: number | null; risk?: boolean; compact?: boolean }>(), {
  value: null,
  risk: false,
  compact: false,
});
</script>
<template>
  <div class="score" :class="[{ risk, compact }, risk && (value ?? 0) >= 65 ? 'high-risk' : '']">
    <div class="score-head">
      <span>{{ risk ? '风险' : '机会' }}评分</span
      ><b>{{ number(value) }}<small v-if="value !== null"> / 100</small></b>
    </div>
    <div class="score-track">
      <span :style="{ width: `${Math.max(0, Math.min(value ?? 0, 100))}%` }" />
    </div>
  </div>
</template>
