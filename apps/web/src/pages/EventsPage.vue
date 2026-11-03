<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { z } from 'zod';
import { EventSchema } from '@radar/shared';
import { api, queryString } from '../lib/api';
import { number } from '../lib/format';
import DataState from '../components/DataState.vue';
import EventList from '../components/EventList.vue';
import RadarIcon from '../components/RadarIcon.vue';
const route = useRoute();
const router = useRouter();
const q = ref(String(route.query.q ?? ''));
const priority = ref(String(route.query.priority ?? ''));
const category = ref(String(route.query.category ?? ''));
const asset = ref(String(route.query.asset ?? ''));
const page = ref(1);
const filters = computed(() => ({
  q: q.value,
  priority: priority.value,
  category: category.value,
  asset: asset.value,
  page: page.value,
  pageSize: 15,
}));
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['events', filters],
  queryFn: () => api(`/events${queryString(filters.value)}`, {}, z.array(EventSchema)),
});
watch([q, priority, category, asset], () => {
  page.value = 1;
  void router.replace({
    query: {
      ...(q.value ? { q: q.value } : {}),
      ...(priority.value ? { priority: priority.value } : {}),
      ...(category.value ? { category: category.value } : {}),
      ...(asset.value ? { asset: asset.value } : {}),
    },
  });
});
</script>
<template>
  <div class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">INTELLIGENCE FEED</div>
        <h1>实时热点<span class="title-dot">.</span></h1>
        <p>追踪金融与链上变化，把每条消息放回证据之中。</p>
      </div>
      <button class="btn" @click="refetch()">
        <RadarIcon name="refresh" :size="15" />刷新情报
      </button>
    </div>
    <div class="filter-bar">
      <div class="search-field">
        <RadarIcon name="search" :size="17" /><input
          v-model="q"
          placeholder="搜索事件、项目或关键词…"
          aria-label="搜索事件"
          maxlength="200"
        />
      </div>
      <select v-model="category" aria-label="事件分类">
        <option value="">全部分类</option>
        <option value="crypto">加密资产</option>
        <option value="macro">全球宏观</option>
        <option value="finance">财经市场</option>
        <option value="technology">科技动态</option>
        <option value="world">全球热点</option>
        <option value="bitcoin">Bitcoin</option>
        <option value="gold">黄金</option>
        <option value="oil">原油</option>
        <option value="treasury">美国国债</option></select
      ><select v-model="priority" aria-label="预警级别">
        <option value="">全部级别</option>
        <option v-for="level in ['P0', 'P1', 'P2', 'P3']" :key="level">{{ level }}</option></select
      ><select v-model="asset" aria-label="资产筛选">
        <option value="">全部资产</option>
        <option v-for="symbol in ['BTC', 'ETH', 'SOL', 'XAU', 'WTI', 'US10Y']" :key="symbol">
          {{ symbol }}
        </option>
      </select>
    </div>
    <div class="list-summary">
      <span>{{ number(data?.meta?.total) }} 条情报</span
      ><span><span class="status-dot tiny" />来源、首次发现时间与置信度均可追溯</span>
    </div>
    <section class="panel">
      <DataState
        :loading="isPending"
        :error="error"
        :empty="data?.data.length === 0"
        @retry="refetch()"
        ><EventList :events="data?.data ?? []"
      /></DataState>
    </section>
    <div v-if="(data?.meta?.total ?? 0) > 15" class="pagination">
      <button class="btn" :disabled="page <= 1" @click="page--">上一页</button
      ><span>第 {{ page }} 页 · 共 {{ Math.ceil((data?.meta?.total ?? 0) / 15) }} 页</span
      ><button class="btn" :disabled="page * 15 >= (data?.meta?.total ?? 0)" @click="page++">
        下一页
      </button>
    </div>
  </div>
</template>
