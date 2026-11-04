<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
import { z } from 'zod';
import { MarketSchema } from '@radar/shared';
import { api } from '../lib/api';
import { date, number } from '../lib/format';
import DataState from './DataState.vue';
import RadarIcon from './RadarIcon.vue';
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['market-assets'],
  queryFn: () => api('/markets/assets', {}, z.array(MarketSchema)),
});
const names: Record<string, string> = { XAU: '现货黄金', WTI: 'WTI 原油' };
</script>
<template>
  <section class="panel commodity-monitor" aria-labelledby="commodity-monitor-heading">
    <div class="panel-heading">
      <div>
        <span class="section-number">03</span>
        <h2 id="commodity-monitor-heading">黄金与原油</h2>
      </div>
      <RouterLink to="/markets?asset=XAU" class="text-link"
        >行情监控<RadarIcon name="arrow" :size="14"
      /></RouterLink>
    </div>
    <DataState :loading="isPending" :error="error" @retry="refetch()">
      <div class="commodity-quotes">
        <RouterLink
          v-for="symbol in ['XAU', 'WTI']"
          :key="symbol"
          :to="`/markets?asset=${symbol}`"
          class="commodity-quote"
        >
          <template
            v-for="item in [data?.data.find((row) => row.asset === symbol)]"
            :key="item?.asset ?? symbol"
          >
            <span class="commodity-name"
              >{{ names[symbol] }}<span class="muted">{{ symbol }}</span></span
            >
            <strong
              >{{ item?.value == null ? '暂无观测' : number(item.value, 2)
              }}<small v-if="item?.value != null">{{ item.unit }}</small></strong
            >
            <span class="muted text-xs"
              >{{ item?.dataMode === 'fixture' ? 'Fixture · ' : ''
              }}{{
                item?.frequency === 'daily'
                  ? `日度参考价 · ${item.sourceDate ?? '日期未知'}`
                  : item?.observedAt
                    ? `供应商更新 ${date(item.observedAt)}`
                    : '等待数据源采集'
              }}</span
            >
            <span class="muted text-xs"
              >{{ item?.sourceId === 'unconfigured' || !item ? '查看行情与来源详情' : item.sourceId
              }}<RadarIcon name="arrow" :size="12"
            /></span>
          </template>
        </RouterLink>
      </div>
    </DataState>
  </section>
</template>
<style scoped>
.commodity-monitor {
  margin-top: 24px;
}
.commodity-quotes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.commodity-quote {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 22px 26px;
  min-width: 0;
  border-top: 1px solid var(--border);
}
.commodity-quote + .commodity-quote {
  border-left: 1px solid var(--border);
}
.commodity-quote:hover {
  background: var(--surface-raised);
}
.commodity-name {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
}
.commodity-quote strong {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.5px;
}
.commodity-quote small {
  font-size: 10px;
  color: var(--text-secondary);
  margin-left: 8px;
  font-weight: 400;
  letter-spacing: 0;
}
.commodity-quote .text-xs {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .commodity-quotes {
    grid-template-columns: 1fr;
  }
  .commodity-quote + .commodity-quote {
    border-left: 0;
  }
  .commodity-quote {
    padding: 20px;
  }
}
</style>
