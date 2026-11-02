<script setup lang="ts">
import type { RadarEvent } from '../lib/models';
import { label, relative } from '../lib/format';
import RadarIcon from './RadarIcon.vue';
import StatusBadge from './StatusBadge.vue';
defineProps<{ events: RadarEvent[]; compact?: boolean }>();
</script>
<template>
  <div class="event-list">
    <RouterLink
      v-for="event in events"
      :key="event.id"
      :to="`/events/${event.id}`"
      class="event-row"
      :class="{ compact }"
      ><div class="event-priority">
        <span :class="`priority priority-${event.severity?.toLowerCase()}`">{{
          event.severity
        }}</span
        ><span class="event-line" />
      </div>
      <div class="event-main">
        <div class="event-kicker">
          <span>{{ label(event.categories?.[0] ?? event.eventType) }}</span
          ><span>·</span><span>{{ event.sourceId }}</span
          ><StatusBadge v-if="event.dataMode === 'fixture'" value="fixture" />
        </div>
        <h3>{{ event.title }}</h3>
        <p v-if="!compact">{{ event.description }}</p>
        <div class="event-meta">
          <span v-for="asset in event.assets?.slice(0, 3)" :key="asset" class="asset-chip">{{
            asset
          }}</span
          ><span>{{ relative(event.firstSeenAt) }}</span
          ><span>{{ Math.round(event.confidence * 100) }}% 置信度</span
          ><span v-if="event.verificationStatus === 'VERIFIED'" class="text-teal">来源已验证</span>
        </div>
      </div>
      <RadarIcon name="chevron" :size="16" class="muted"
    /></RouterLink>
  </div>
</template>
