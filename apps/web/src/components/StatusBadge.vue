<script setup lang="ts">
import { label } from '../lib/format';
defineProps<{ value?: string | null; text?: string }>();
</script>
<template>
  <span class="badge" :class="`badge-${value?.toLowerCase() ?? 'unknown'}`"
    ><span
      v-if="['healthy', 'HEALTHY', 'ACTIVE', 'live'].includes(value ?? '')"
      class="status-dot"
    />{{ text ?? label(value) }}</span
  >
</template>
