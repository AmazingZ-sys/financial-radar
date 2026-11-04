<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { DashboardSchema } from '@radar/shared';
import { api } from '../lib/api';
import { date, number } from '../lib/format';
import RadarIcon from '../components/RadarIcon.vue';
import DataState from '../components/DataState.vue';
import EventList from '../components/EventList.vue';
import ProjectCard from '../components/ProjectCard.vue';
import RadarChart from '../components/RadarChart.vue';
import CommodityMonitor from '../components/CommodityMonitor.vue';
const { data, isPending, error, refetch, isFetching } = useQuery({
  queryKey: ['dashboard'],
  queryFn: () => api('/dashboard', {}, DashboardSchema),
});
const dashboard = computed(() => data.value?.data);
const points = computed(
  () =>
    dashboard.value?.trend.map((point) => ({
      time: date(point.time).split(' ').at(-1) ?? point.time,
      value: point.events,
    })) ?? [],
);
</script>
<template>
  <div class="page dashboard-page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">RADAR OVERVIEW <span class="eyebrow-line" /></div>
        <h1>雷达总览<span class="title-dot">.</span></h1>
        <p>在市场形成共识之前，发现值得研究的信号。</p>
      </div>
      <div class="page-actions">
        <span class="updated-label">{{
          data ? `数据更新于 ${date(data.data.asOf)}` : '等待数据'
        }}</span
        ><button class="btn" :disabled="isFetching" @click="refetch()">
          <RadarIcon name="refresh" :size="15" :class="{ spinning: isFetching }" />刷新
        </button>
      </div>
    </div>
    <DataState :loading="isPending" :error="error" @retry="refetch()"
      ><template v-if="dashboard"
        ><section class="overview-hero">
          <div>
            <span class="section-eyebrow"
              ><span class="status-dot" :class="{ offline: !dashboard.workerOnline }" />{{
                dashboard.workerOnline ? '监测引擎运行中' : 'Worker 暂未连接'
              }}</span
            >
            <h2>捕捉变化。<br /><em>让早期信号浮出水面。</em></h2>
            <p>
              从链上首次出现到官方首次公开，<br
                class="desktop-only"
              />持续追踪每一个关键阶段，保留完整证据。
            </p>
            <RouterLink to="/projects" class="hero-link"
              >探索早期机会<RadarIcon name="arrow" :size="17"
            /></RouterLink>
          </div>
          <div class="hero-radar" aria-hidden="true">
            <div class="radar-ring ring-one" />
            <div class="radar-ring ring-two" />
            <div class="radar-ring ring-three" />
            <div class="radar-axis axis-one" />
            <div class="radar-axis axis-two" />
            <div class="radar-sweep" />
            <div class="radar-center" />
            <div class="radar-dot dot-one" />
            <div class="radar-dot dot-two" />
            <div class="radar-dot dot-three" />
            <span class="radar-coord coord-one">SIGNAL / EVIDENCE</span
            ><span class="radar-coord coord-two"
              >{{ String(dashboard.onlineSources).padStart(2, '0') }} SOURCES CONNECTED</span
            ><span class="radar-label">EARLY DISCOVERY NETWORK</span>
          </div>
          <div class="hero-index">
            <span>01 / DISCOVER</span><strong>更早发现<br />更清晰判断</strong
            ><small>机会与风险，独立评估。</small>
          </div>
        </section>
        <section class="metric-grid">
          <div class="metric-card">
            <div class="metric-label">在线数据源<RadarIcon name="source" :size="16" /></div>
            <div class="metric-value">
              {{ number(dashboard.onlineSources)
              }}<small>/ {{ number(dashboard.totalSources) }}</small>
            </div>
            <div class="metric-foot">
              <span class="status-dot" :class="{ offline: dashboard.onlineSources === 0 }" />{{
                dashboard.onlineSources ? '已连接的健康来源' : '等待数据源连接'
              }}
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-label">今日识别事件<RadarIcon name="feed" :size="16" /></div>
            <div class="metric-value">{{ number(dashboard.eventsToday) }}<small>条</small></div>
            <div class="metric-foot">{{ number(dashboard.collectedToday) }} 条原始数据已采集</div>
          </div>
          <div class="metric-card metric-highlight">
            <div class="metric-label">今日新发现<RadarIcon name="opportunity" :size="16" /></div>
            <div class="metric-value">
              {{ number(dashboard.projectsToday) }}<small>个项目</small>
            </div>
            <div class="metric-foot"><span class="text-accent">EARLY OPPORTUNITIES</span></div>
          </div>
          <div class="metric-card">
            <div class="metric-label">高优先级预警<RadarIcon name="bell" :size="16" /></div>
            <div class="metric-value">
              {{ number(dashboard.highPriorityAlerts) }}<small>条 P0 / P1</small>
            </div>
            <div class="metric-foot">
              平台接受率
              {{
                dashboard.notificationSuccessRate === null
                  ? '暂无记录'
                  : `${number(dashboard.notificationSuccessRate, 1)}%`
              }}
            </div>
          </div>
        </section>
        <section class="section-block">
          <div class="section-heading">
            <div>
              <span class="section-number">01</span>
              <h2>早期机会雷达</h2>
              <span class="section-subtitle">从首次出现，开始观察</span>
            </div>
            <RouterLink to="/projects" class="text-link"
              >全部项目<RadarIcon name="arrow" :size="14"
            /></RouterLink>
          </div>
          <div v-if="dashboard.recentProjects.length" class="project-grid">
            <ProjectCard
              v-for="project in dashboard.recentProjects.slice(0, 3)"
              :key="project.id"
              :project="project"
            />
          </div>
          <div v-else class="empty-inline">
            尚未发现候选项目。可先在数据源页面检查链上 Connector 配置。
          </div>
        </section>
        <div class="dashboard-bottom">
          <section class="panel">
            <div class="panel-heading">
              <div>
                <span class="section-number">02</span>
                <h2>最新情报</h2>
              </div>
              <RouterLink to="/events" class="text-link"
                >查看全部<RadarIcon name="arrow" :size="14"
              /></RouterLink>
            </div>
            <EventList
              v-if="dashboard.recentEvents.length"
              :events="dashboard.recentEvents.slice(0, 5)"
              compact
            />
            <div v-else class="empty-inline">暂无事件，系统会保留每次发现的来源与证据。</div>
          </section>
          <div class="dashboard-side">
            <section class="panel">
              <div class="panel-heading">
                <h2>发现节奏</h2>
                <span class="muted text-xs">事件采集趋势</span>
              </div>
              <RadarChart v-if="points.length" :points="points" kind="bar" :height="175" />
              <div v-else class="empty-inline">暂无时间序列</div>
              <div class="chart-caption">
                <span><i class="legend-dot" />已识别事件</span><span>来源：系统持久化记录</span>
              </div>
            </section>
            <section class="panel latency-panel">
              <div class="panel-heading">
                <h2>发现链路</h2>
                <span
                  class="badge"
                  :class="dashboard.workerOnline ? 'badge-healthy' : 'badge-degraded'"
                  >{{ dashboard.workerOnline ? '运行中' : '等待 Worker' }}</span
                >
              </div>
              <div class="latency-metrics">
                <div>
                  <span>发现延迟 P50</span
                  ><b>{{
                    dashboard.latency.p50Ms === null
                      ? '—'
                      : `${number(dashboard.latency.p50Ms / 1000, 1)}s`
                  }}</b>
                </div>
                <div>
                  <span>发现延迟 P95</span
                  ><b>{{
                    dashboard.latency.p95Ms === null
                      ? '—'
                      : `${number(dashboard.latency.p95Ms / 1000, 1)}s`
                  }}</b>
                </div>
              </div>
              <p>{{ number(dashboard.latency.samples) }} 个有效样本 · 未知发布时间不计入统计</p>
              <RouterLink to="/system" class="text-link"
                >查看服务状态<RadarIcon name="arrow" :size="14"
              /></RouterLink>
            </section>
          </div>
        </div>
        <CommodityMonitor />
        <div class="research-notice">
          <RadarIcon name="shield" :size="17" />
          <p>发现信号是研究的起点。机会评分与风险评分独立计算，未知资产始终需要核验。</p>
          <span>EVIDENCE FIRST</span>
        </div></template
      ></DataState
    >
  </div>
</template>
