<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { z } from 'zod';
import { ProjectSchema } from '@radar/shared';
import { api, queryString } from '../lib/api';
import { label, number } from '../lib/format';
import DataState from '../components/DataState.vue';
import RadarIcon from '../components/RadarIcon.vue';
import ProjectCard from '../components/ProjectCard.vue';
const q = ref('');
const chain = ref('');
const stage = ref('');
const verified = ref('');
const page = ref(1);
const filters = computed(() => ({
  q: q.value,
  chain: chain.value,
  stage: stage.value,
  verified: verified.value,
  page: page.value,
  pageSize: 12,
}));
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['projects', filters],
  queryFn: () => api(`/projects${queryString(filters.value)}`, {}, z.array(ProjectSchema)),
});
watch([q, chain, stage, verified], () => {
  page.value = 1;
});
</script>
<template>
  <div class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow"><RadarIcon name="opportunity" :size="14" /> EARLY SIGNALS</div>
        <h1>早期机会<span class="title-dot">.</span></h1>
        <p>关注刚刚出现的新协议、新资产与新叙事。以证据开始，以风险为界。</p>
      </div>
      <button class="btn" @click="refetch()">
        <RadarIcon name="refresh" :size="15" />刷新信号
      </button>
    </div>
    <div class="opportunity-intro">
      <div>
        <span class="section-eyebrow">DISCOVER → VERIFY → TRACK</span>
        <h2>在故事被广泛讲述之前，<em>先看见信号。</em></h2>
      </div>
      <p>机会评分衡量发现价值；风险评分独立计算。<br />未经核验的信号，不等于已验证的参与机会。</p>
    </div>
    <div class="filter-bar">
      <div class="search-field">
        <RadarIcon name="search" :size="17" /><input
          v-model="q"
          placeholder="搜索项目或资产标识…"
          aria-label="搜索项目"
          maxlength="200"
        />
      </div>
      <select v-model="chain" aria-label="所属公链">
        <option value="">全部公链</option>
        <option value="bitcoin">Bitcoin</option>
        <option value="ethereum">Ethereum</option>
        <option value="solana">Solana</option></select
      ><select v-model="stage" aria-label="生命周期阶段">
        <option value="">全部阶段</option>
        <option
          v-for="value in [
            'DISCOVERED',
            'EARLY_STAGE',
            'ACTIVE',
            'TRADING',
            'COMPLETED',
            'INACTIVE',
          ]"
          :key="value"
          :value="value"
        >
          {{ label(value) }}
        </option></select
      ><select v-model="verified" aria-label="验证状态">
        <option value="">全部验证状态</option>
        <option value="true">已验证</option>
        <option value="false">待验证</option>
      </select>
    </div>
    <div class="list-summary">
      <span>{{ number(data?.meta?.total) }} 个候选项目</span><span>每个项目可包含多个独立信号</span>
    </div>
    <DataState
      :loading="isPending"
      :error="error"
      :empty="data?.data.length === 0"
      empty-text="当前筛选下暂无候选项目"
      @retry="refetch()"
      ><div class="project-grid">
        <ProjectCard v-for="project in data?.data" :key="project.id" :project="project" /></div
    ></DataState>
    <div v-if="(data?.meta?.total ?? 0) > 12" class="pagination">
      <button class="btn" :disabled="page <= 1" @click="page--">上一页</button
      ><span>第 {{ page }} 页</span
      ><button class="btn" :disabled="page * 12 >= (data?.meta?.total ?? 0)" @click="page++">
        下一页
      </button>
    </div>
    <div class="research-notice">
      <RadarIcon name="warning" :size="17" />
      <p>新资产可能具有流动性、权限与未知合约风险。本平台仅提供信号与证据，不执行资金操作。</p>
    </div>
  </div>
</template>
