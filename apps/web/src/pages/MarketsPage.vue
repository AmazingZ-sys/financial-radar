<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { z } from 'zod';
import { MarketSchema } from '@radar/shared';
import { api, queryString } from '../lib/api';
import type { MarketPoint } from '../lib/models';
import { date, number, percent, safeUrl } from '../lib/format';
import DataState from '../components/DataState.vue';
import RadarIcon from '../components/RadarIcon.vue';
import RadarChart from '../components/RadarChart.vue';
import StatusBadge from '../components/StatusBadge.vue';
const selected = ref('BTC');
const range = ref('7');
const DisplayMarketSchema = MarketSchema.extend({
  frequency: z.string().optional(),
  sourceDate: z.string().nullable().optional(),
  delayLabel: z.string().optional(),
  publicationTimeKnown: z.boolean().optional(),
  sourceUrl: z.string().nullable().optional(),
});
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['market-assets'],
  queryFn: () => api('/markets/assets', {}, z.array(DisplayMarketSchema)),
});
const historyFilters = computed(() => ({
  asset: selected.value,
  from: new Date(Date.now() - Number(range.value) * 86400000).toISOString(),
  to: new Date().toISOString(),
}));
const {
  data: history,
  isPending: historyPending,
  error: historyError,
  refetch: refreshHistory,
} = useQuery({
  queryKey: ['market-history', selected, range],
  queryFn: () => api<MarketPoint[]>(`/markets/history${queryString(historyFilters.value)}`),
});
const asset = computed(() => data.value?.data.find((item) => item.asset === selected.value));
const points = computed(
  () =>
    history.value?.data
      .filter((p) => typeof p.value === 'number')
      .map((p) => ({
        time:
          p.frequency === 'daily' && p.sourceDate
            ? p.sourceDate
            : date(p.observedAt ?? p.timestamp ?? p.asOf),
        value: p.value,
      })) ?? [],
);
watch(data, (value) => {
  if (value?.data.length && !value.data.some((item) => item.asset === selected.value))
    selected.value = value.data[0]?.asset ?? 'BTC';
});
function refresh() {
  void refetch();
  void refreshHistory();
}
</script>
<template>
  <div class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">MARKET OBSERVATORY</div>
        <h1>行情监控<span class="title-dot">.</span></h1>
        <p>只呈现最新可用观测。每一条价格，都有来源与时间。</p>
      </div>
      <button class="btn" @click="refresh"><RadarIcon name="refresh" :size="15" />更新行情</button>
    </div>
    <DataState
      :loading="isPending"
      :error="error"
      :empty="data?.data.length === 0"
      empty-text="尚无可用行情资产"
      @retry="refetch()"
      ><div class="market-cards">
        <button
          v-for="item in data?.data"
          :key="item.asset"
          class="market-card"
          :class="{ selected: selected === item.asset }"
          @click="selected = item.asset"
        >
          <div class="market-card-heading">
            <span class="market-symbol">{{ item.asset }}</span
            ><StatusBadge v-if="item.dataMode === 'fixture'" value="fixture" /><span
              v-else
              class="muted text-xs"
              >{{
                item.value === null
                  ? '待接入'
                  : item.frequency === 'daily'
                    ? '日度参考数据'
                    : '可用观测'
              }}</span
            >
          </div>
          <span class="market-name"
            >{{ item.name
            }}<span v-if="item.frequency === 'daily'" class="daily-label"
              >日度 · {{ item.sourceDate ?? '日期未知' }}</span
            ></span
          ><strong
            >{{ item.value === null ? '暂无数据' : number(item.value, item.unit === '%' ? 3 : 2)
            }}<small v-if="item.value !== null">{{ item.unit }}</small></strong
          >
          <div class="market-card-foot">
            <span :class="(item.changePct ?? 0) >= 0 ? 'text-teal' : 'text-danger'">{{
              percent(item.changePct, 2)
            }}</span
            ><span>{{
              item.frequency === 'daily'
                ? `采样 ${date(item.observedAt)}`
                : item.observedAt
                  ? date(item.observedAt)
                  : '时间未知'
            }}</span>
          </div>
        </button>
      </div>
      <section class="panel market-chart-panel">
        <div class="panel-heading">
          <div>
            <h2>
              {{ asset?.name ?? selected }}<span class="section-subtitle">{{ selected }}</span>
            </h2>
          </div>
          <div class="segmented">
            <button
              v-for="days in ['1', '7', '30']"
              :key="days"
              :class="{ active: range === days }"
              @click="range = days"
            >
              {{ days }} 天
            </button>
          </div>
        </div>
        <div class="market-chart-value">
          <strong>{{
            asset?.value === null || asset?.value === undefined ? '—' : number(asset.value, 2)
          }}</strong
          ><span>{{ asset?.unit }}</span
          ><span :class="(asset?.changePct ?? 0) >= 0 ? 'text-teal' : 'text-danger'">{{
            percent(asset?.changePct, 2)
          }}</span>
        </div>
        <DataState
          :loading="historyPending"
          :error="historyError"
          :empty="points.length === 0"
          empty-text="该时间段暂无持久化历史数据"
          @retry="refreshHistory()"
          ><RadarChart :points="points" :height="320" :unit="asset?.unit ?? ''"
        /></DataState>
        <div class="chart-caption">
          <span><i class="legend-dot" />实际采样观测，不补造缺失价格</span
          ><span
            >来源 {{ asset?.sourceId ?? '未知' }} ·
            {{ asset?.frequency === 'daily' ? '系统采样时间' : '数据时间' }}
            {{ date(asset?.observedAt, true) }}</span
          >
        </div>
      </section>
      <div class="notice-box">
        <RadarIcon name="clock" :size="17" />
        <p>
          {{
            asset?.frequency === 'daily'
              ? `日度参考数据，来源日期 ${asset.sourceDate ?? '未知'}。${asset.delayLabel ?? '来源未提供发布时间'}。系统采样时间不代表来源发布时间。`
              : '数据延迟：'
          }}<template v-if="asset?.frequency !== 'daily'"
            >{{
              asset?.delaySeconds === null || asset?.delaySeconds === undefined
                ? '来源未提供'
                : `${number(asset.delaySeconds)} 秒`
            }}。</template
          >宏观日度数据与实时交易价格分别标记；未获授权的数据不以历史价格补位。<a
            v-if="safeUrl(asset?.sourceUrl)"
            :href="safeUrl(asset?.sourceUrl)"
            class="text-link"
            target="_blank"
            rel="noopener noreferrer"
            >查看官方数据来源<RadarIcon name="external" :size="12"
          /></a>
        </p></div
    ></DataState>
  </div>
</template>
