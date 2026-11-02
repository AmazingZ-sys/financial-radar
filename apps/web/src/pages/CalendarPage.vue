<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { z } from 'zod';
import { api } from '../lib/api';
import { date, displayTimezone, safeUrl } from '../lib/format';
import DataState from '../components/DataState.vue';
import RadarIcon from '../components/RadarIcon.vue';
import StatusBadge from '../components/StatusBadge.vue';
const CalendarSchema = z.object({
  id: z.string(),
  title: z.string(),
  country: z.string(),
  scheduledAt: z.string(),
  previousValue: z.string().nullable(),
  expectedValue: z.string().nullable(),
  actualValue: z.string().nullable(),
  importance: z.enum(['high', 'medium', 'low']),
  confirmed: z.boolean(),
  sourceUrl: z.string(),
  sourcePublishedAt: z.string().nullable(),
  dataMode: z.enum(['fixture', 'live']),
});
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['calendar'],
  queryFn: () => api('/calendar', {}, z.array(CalendarSchema)),
});
const country = ref('');
const importance = ref('');
const countries = computed(() => [
  ...new Set(data.value?.data.map((event) => event.country) ?? []),
]);
const events = computed(
  () =>
    data.value?.data
      .filter(
        (event) =>
          (!country.value || event.country === country.value) &&
          (!importance.value || event.importance === importance.value),
      )
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)) ?? [],
);
const importanceLabels = { high: '高影响', medium: '中等影响', low: '常规' };
</script>
<template>
  <div class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">ECONOMIC CALENDAR</div>
        <h1>经济日历<span class="title-dot">.</span></h1>
        <p>为重要经济数据留出研究时间。预期、实际与发布确认分别记录。</p>
      </div>
      <button class="btn" @click="refetch()">
        <RadarIcon name="refresh" :size="15" />刷新日程
      </button>
    </div>
    <div class="calendar-intro">
      <div>
        <RadarIcon name="calendar" :size="25" />
        <div>
          <h2>宏观事件观察窗口</h2>
          <p>当前显示时区 {{ displayTimezone }} · 不提供未经可靠来源确认的预期值。</p>
        </div>
      </div>
      <span class="eyebrow">TIMING / CONTEXT / EVIDENCE</span>
    </div>
    <div class="filter-bar">
      <select v-model="country" aria-label="国家或地区">
        <option value="">全部国家或地区</option>
        <option v-for="value in countries" :key="value" :value="value">{{ value }}</option></select
      ><select v-model="importance" aria-label="日历重要程度">
        <option value="">全部重要程度</option>
        <option v-for="(text, value) in importanceLabels" :key="value" :value="value">
          {{ text }}
        </option></select
      ><span class="calendar-filter-note">来源未提供的字段明确显示“未知”</span>
    </div>
    <section class="panel">
      <DataState
        :loading="isPending"
        :error="error"
        :empty="events.length === 0"
        empty-text="尚无可靠来源的经济事件日程"
        @retry="refetch()"
        ><div class="table-scroll">
          <table class="data-table calendar-table">
            <thead>
              <tr>
                <th>预定发布时间</th>
                <th>国家 / 事件</th>
                <th>重要程度</th>
                <th>历史值</th>
                <th>预期值</th>
                <th>实际值</th>
                <th>发布确认</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="event in events" :key="event.id">
                <td class="mono">{{ date(event.scheduledAt, true) }}</td>
                <td>
                  <div class="calendar-event-name">{{ event.title }}</div>
                  <span class="muted text-xs">{{ event.country }}</span
                  ><StatusBadge v-if="event.dataMode === 'fixture'" value="fixture" />
                </td>
                <td>
                  <span class="importance-badge" :class="event.importance"
                    ><i /><i /><i />{{ importanceLabels[event.importance] }}</span
                  >
                </td>
                <td class="mono">{{ event.previousValue ?? '未知' }}</td>
                <td class="mono">{{ event.expectedValue ?? '未知' }}</td>
                <td class="mono" :class="event.confirmed ? 'text-teal' : 'muted'">
                  {{ event.actualValue ?? '未知' }}
                </td>
                <td>
                  <span
                    class="badge"
                    :class="event.confirmed ? 'badge-verified' : 'badge-unverified'"
                    >{{ event.confirmed ? '已确认发布' : '待确认' }}</span
                  >
                </td>
                <td>
                  <a
                    v-if="safeUrl(event.sourceUrl)"
                    :href="safeUrl(event.sourceUrl)"
                    class="text-link"
                    :title="`来源发布时间 ${date(event.sourcePublishedAt, true)}`"
                    target="_blank"
                    rel="noopener noreferrer"
                    >官方来源<RadarIcon name="external" :size="12" /></a
                  ><span v-else class="muted">未知来源</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div></DataState
      >
    </section>
    <div class="research-notice">
      <RadarIcon name="clock" :size="17" />
      <p>日程可能调整。实际值为空或已到预定时间，不代表数据已经发布；发布确认以可靠来源为准。</p>
    </div>
  </div>
</template>
