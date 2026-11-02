<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { z } from 'zod';
import { ProjectSchema, SignalSchema } from '@radar/shared';
import { ElMessage } from 'element-plus';
import { api, write } from '../lib/api';
import type { TimelineItem, Watchlist } from '../lib/models';
import { date, label, number, percent, safeUrl } from '../lib/format';
import { participationStatus } from '../lib/participation';
import DataState from '../components/DataState.vue';
import RadarIcon from '../components/RadarIcon.vue';
import StatusBadge from '../components/StatusBadge.vue';
import ScoreBar from '../components/ScoreBar.vue';
const route = useRoute();
const busy = ref(false);
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['project', route.params.id],
  queryFn: () => api(`/projects/${String(route.params.id)}`, {}, ProjectSchema),
});
const {
  data: timeline,
  isPending: timelinePending,
  error: timelineError,
  refetch: refreshTimeline,
} = useQuery({
  queryKey: ['project-timeline', route.params.id],
  queryFn: () => api<TimelineItem[]>(`/projects/${String(route.params.id)}/timeline`),
});
const {
  data: signals,
  isPending: signalsPending,
  error: signalsError,
  refetch: refreshSignals,
} = useQuery({
  queryKey: ['project-signals', route.params.id],
  queryFn: () => api(`/projects/${String(route.params.id)}/signals`, {}, z.array(SignalSchema)),
});
interface MetricHistory {
  id: string;
  sourceId: string;
  observedAt: string;
  data: Record<string, unknown>;
}
const {
  data: metrics,
  isPending: metricsPending,
  error: metricsError,
  refetch: refreshMetrics,
} = useQuery({
  queryKey: ['project-metrics', route.params.id],
  queryFn: () => api<MetricHistory[]>(`/projects/${String(route.params.id)}/metrics`),
});
const project = computed(() => data.value?.data);
async function watchProject() {
  if (!project.value) return;
  busy.value = true;
  try {
    let lists = (await api<Watchlist[]>('/watchlists')).data;
    if (!lists.length)
      lists = [(await write<Watchlist>('/watchlists', 'POST', { name: '我的观察列表' })).data];
    const first = lists[0];
    if (!first) throw new Error('无法创建观察列表');
    await write(`/watchlists/${first.id}/items`, 'POST', { assetKey: project.value.assetKey });
    ElMessage.success('已加入观察列表，可在系统管理中查看');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败');
  } finally {
    busy.value = false;
  }
}
function breakdown(value: unknown) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([key, val]) => ({
    key,
    value: typeof val === 'object' ? JSON.stringify(val) : String(val),
  }));
}
</script>
<template>
  <div class="page">
    <RouterLink to="/projects" class="back-link">← 返回早期机会</RouterLink
    ><DataState :loading="isPending" :error="error" @retry="refetch()"
      ><template v-if="project"
        ><div class="detail-heading project-detail-heading">
          <span class="project-avatar large" :class="project.chain">{{
            project.name.slice(0, 1)
          }}</span>
          <div>
            <div class="eyebrow">{{ project.chain }} / {{ project.protocol }}</div>
            <h1>{{ project.name }}</h1>
            <div class="project-tags">
              <StatusBadge :value="project.stage" /><StatusBadge
                :value="project.verificationStatus"
              /><StatusBadge v-if="project.dataMode === 'fixture'" value="fixture" /><span
                class="muted text-xs"
                >首次发现 {{ date(project.firstSeenAt, true) }}</span
              >
            </div>
          </div>
          <button class="btn btn-primary" :disabled="busy" @click="watchProject">
            <RadarIcon name="eye" :size="16" />{{ busy ? '正在保存…' : '加入观察列表' }}
          </button>
        </div>
        <div
          v-if="project.riskFlagged || project.riskWarnings.length"
          class="notice-box risk-banner"
        >
          <RadarIcon name="warning" :size="20" />
          <div>
            <b>重要风险提示</b>
            <p>
              {{
                project.riskWarnings.join('；') ||
                '该项目已被标记重要风险，请优先核验来源、合约权限与参与条件。'
              }}
            </p>
          </div>
        </div>
        <div class="detail-grid">
          <div class="detail-main">
            <section class="panel detail-panel">
              <div class="panel-heading">
                <h2>项目观察</h2>
                <span class="muted text-xs">独立指标 · 非投资结论</span>
              </div>
              <div class="project-detail-stats">
                <div>
                  <span>独立参与者</span><strong>{{ number(project.participants) }}</strong>
                </div>
                <div>
                  <span>参与者变化</span
                  ><strong class="text-teal">{{ percent(project.participantGrowthPct) }}</strong>
                </div>
                <div>
                  <span>铸造进度</span
                  ><strong>{{
                    project.mintProgress === null ? '未知' : `${number(project.mintProgress, 1)}%`
                  }}</strong>
                </div>
              </div>
              <dl class="info-list">
                <div>
                  <dt>资产标识</dt>
                  <dd class="mono break-all">{{ project.assetKey }}</dd>
                </div>
                <div>
                  <dt>参与条件</dt>
                  <dd>{{ project.conditions ?? '尚无可靠证据，等待核验' }}</dd>
                </div>
                <div>
                  <dt>条件核验</dt>
                  <dd>
                    <span
                      class="badge"
                      :class="project.conditionsVerified ? 'badge-verified' : 'badge-unverified'"
                      >{{ project.conditionsVerified ? '参与条件已核验' : '参与条件待核验' }}</span
                    >
                  </dd>
                </div>
                <div>
                  <dt>参与窗口</dt>
                  <dd :class="`text-${participationStatus(project).tone}`">
                    {{ participationStatus(project).text }}
                  </dd>
                </div>
                <div>
                  <dt>开始时间</dt>
                  <dd>{{ date(project.startsAt, true) }}</dd>
                </div>
                <div>
                  <dt>结束时间</dt>
                  <dd>{{ date(project.endsAt, true) }}</dd>
                </div>
              </dl>
              <p class="muted text-xs mt-5">
                窗口状态依据已记录的时间与独立的条件核验标记。开放窗口不代表项目安全或资金操作建议。
              </p>
            </section>
            <section class="panel detail-panel">
              <div class="panel-heading">
                <h2>独立机会信号</h2>
                <span class="muted text-xs">{{ signals?.data.length ?? 0 }} 个信号</span>
              </div>
              <DataState :loading="signalsPending" :error="signalsError" @retry="refreshSignals()">
                <div v-for="signal in signals?.data ?? []" :key="signal.id" class="signal-row">
                  <span class="signal-icon"><RadarIcon name="opportunity" :size="18" /></span>
                  <div>
                    <h3>{{ label(signal.type) }}</h3>
                    <p>{{ signal.reason }}</p>
                    <span class="muted text-xs"
                      >{{ date(signal.detectedAt, true) }} · 评分版本 {{ signal.scoringVersion }} ·
                      {{ signal.evidenceIds.length }} 条证据</span
                    >
                    <details v-if="signal.evidenceIds.length" class="signal-evidence">
                      <summary>{{ signal.evidenceIds.length }} 条关联证据</summary>
                      <code v-for="evidenceId in signal.evidenceIds" :key="evidenceId">{{
                        evidenceId
                      }}</code
                      ><RouterLink
                        v-if="signal.eventId"
                        :to="`/events/${signal.eventId}`"
                        class="text-link"
                        >查看信号事件与来源<RadarIcon name="arrow" :size="12"
                      /></RouterLink>
                    </details>
                  </div>
                </div>
                <div v-if="!signals?.data.length" class="empty-inline">
                  尚无可用的独立信号记录。
                </div>
              </DataState>
            </section>
            <section class="panel detail-panel">
              <div class="panel-heading">
                <h2>发现时间线</h2>
                <RadarIcon name="clock" :size="17" />
              </div>
              <DataState
                :loading="timelinePending"
                :error="timelineError"
                @retry="refreshTimeline()"
              >
                <div class="timeline">
                  <div
                    v-for="(item, index) in timeline?.data ?? []"
                    :key="item.id ?? index"
                    class="timeline-row"
                  >
                    <span class="timeline-dot" />
                    <div>
                      <time>{{
                        date(item.createdAt ?? item.occurredAt ?? item.timestamp, true)
                      }}</time>
                      <h3>
                        {{
                          item.title ??
                          label(item.toStage ?? item.eventType ?? item.type ?? item.stage)
                        }}
                      </h3>
                      <p>
                        {{
                          item.reason ??
                          item.description ??
                          (item.details ? JSON.stringify(item.details) : '')
                        }}
                      </p>
                    </div>
                  </div>
                </div>
                <div v-if="!timeline?.data.length" class="empty-inline">尚无阶段变更记录。</div>
              </DataState>
            </section>
            <section class="panel detail-panel">
              <div class="panel-heading">
                <h2>历史链上指标</h2>
                <span class="muted text-xs">实际观测记录 · 不插值</span>
              </div>
              <DataState
                :loading="metricsPending"
                :error="metricsError"
                :empty="metrics?.data.length === 0"
                empty-text="尚无历史指标观测"
                @retry="refreshMetrics()"
                ><div class="table-scroll">
                  <table class="data-table">
                    <thead>
                      <tr>
                        <th>观测时间</th>
                        <th>来源</th>
                        <th>指标快照</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="item in metrics?.data" :key="item.id">
                        <td>{{ date(item.observedAt, true) }}</td>
                        <td>{{ item.sourceId }}</td>
                        <td>
                          <span v-for="(value, key) in item.data" :key="key" class="metric-snapshot"
                            >{{ label(String(key)) }}:
                            {{
                              value === null
                                ? '未知'
                                : typeof value === 'object'
                                  ? JSON.stringify(value)
                                  : value
                            }}</span
                          >
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div></DataState
              >
            </section>
          </div>
          <aside class="detail-side">
            <section class="panel detail-panel">
              <h2>评分与解释</h2>
              <div class="mt-5"><ScoreBar :value="project.opportunityScore" /></div>
              <div
                v-for="item in breakdown(project.opportunityBreakdown)"
                :key="item.key"
                class="breakdown-row"
              >
                <span>{{ label(item.key) }}</span
                ><span>{{ item.value }}</span>
              </div>
              <div class="mt-5"><ScoreBar :value="project.riskScore" risk /></div>
              <div
                v-for="item in breakdown(project.riskBreakdown)"
                :key="item.key"
                class="breakdown-row"
              >
                <span>{{ label(item.key) }}</span
                ><span>{{ item.value }}</span>
              </div>
              <p class="muted text-xs mt-5">
                机会与风险独立计算。缺少可靠证据时维持待验证，不推断安全性。
              </p>
            </section>
            <section class="panel detail-panel">
              <div class="panel-heading">
                <h2>项目来源</h2>
                <RadarIcon name="link" :size="17" />
              </div>
              <template v-for="url in project.sourceUrls" :key="url"
                ><a
                  v-if="safeUrl(url)"
                  :href="safeUrl(url)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="source-link"
                  >{{ url }}<RadarIcon name="external" :size="13" /></a
              ></template>
              <p v-if="!project.sourceUrls.length" class="muted">尚未提供可靠来源链接。</p>
            </section>
          </aside>
        </div></template
      ></DataState
    >
  </div>
</template>
