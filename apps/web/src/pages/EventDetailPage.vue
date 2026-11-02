<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { EventSchema } from '@radar/shared';
import { api, write } from '../lib/api';
import type { Evidence } from '../lib/models';
import { date, label, safeUrl } from '../lib/format';
import DataState from '../components/DataState.vue';
import RadarIcon from '../components/RadarIcon.vue';
import StatusBadge from '../components/StatusBadge.vue';
import ScoreBar from '../components/ScoreBar.vue';
const route = useRoute();
const reviewNote = ref('');
const reviewBusy = ref(false);
const reviewError = ref('');
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['event', route.params.id],
  queryFn: () => api(`/events/${String(route.params.id)}`, {}, EventSchema),
});
const {
  data: sources,
  isPending: sourcesPending,
  error: sourcesError,
  refetch: refreshSources,
} = useQuery({
  queryKey: ['event-sources', route.params.id],
  queryFn: () => api<Evidence[]>(`/events/${String(route.params.id)}/sources`),
});
async function review(status: 'APPROVED' | 'REJECTED') {
  reviewBusy.value = true;
  reviewError.value = '';
  try {
    await write(`/events/${String(route.params.id)}/review`, 'POST', {
      status,
      ...(reviewNote.value.trim() ? { note: reviewNote.value.trim() } : {}),
    });
    reviewNote.value = '';
    await refetch();
  } catch (err) {
    reviewError.value = err instanceof Error ? err.message : '复核保存失败';
  } finally {
    reviewBusy.value = false;
  }
}
const event = computed(() => data.value?.data);
const analysis = computed(() =>
  event.value?.analysis && typeof event.value.analysis === 'object'
    ? (event.value.analysis as Record<string, unknown>)
    : null,
);
function jsonText(value: unknown): string {
  if (value === undefined) return '未知';
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? '未知' : serialized;
  } catch {
    return '原始数据无法展示';
  }
}
function breakdown(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, item]) => ({
    key,
    value: typeof item === 'object' ? jsonText(item) : String(item),
  }));
}
</script>
<template>
  <div class="page">
    <RouterLink to="/events" class="back-link">← 返回实时热点</RouterLink
    ><DataState :loading="isPending" :error="error" @retry="refetch()"
      ><template v-if="event"
        ><div class="detail-heading">
          <div class="project-tags">
            <span :class="`priority priority-${event.severity.toLowerCase()}`">{{
              event.severity
            }}</span
            ><StatusBadge :value="event.verificationStatus" /><StatusBadge
              v-if="event.dataMode === 'fixture'"
              value="fixture"
            /><span class="muted text-xs">{{ label(event.eventType) }}</span>
          </div>
          <h1>{{ event.title }}</h1>
          <p>{{ event.sourceId }} <span>·</span> 首次发现 {{ date(event.firstSeenAt, true) }}</p>
        </div>
        <div class="detail-grid">
          <div class="detail-main">
            <section class="panel detail-panel">
              <div class="panel-heading">
                <h2>事件事实</h2>
                <RadarIcon name="feed" :size="17" />
              </div>
              <p class="detail-description">{{ event.description }}</p>
              <div class="project-tags">
                <span v-for="asset in event.assets" :key="asset" class="asset-chip">{{
                  asset
                }}</span
                ><span v-for="category in event.categories" :key="category" class="badge">{{
                  label(category)
                }}</span>
              </div>
              <a
                v-if="safeUrl(event.originalUrl)"
                class="btn mt-5"
                :href="safeUrl(event.originalUrl)"
                target="_blank"
                rel="noopener noreferrer"
                >查看原始来源<RadarIcon name="external" :size="14"
              /></a>
            </section>
            <section class="panel detail-panel">
              <div class="panel-heading">
                <h2>AI 辅助解读</h2>
                <StatusBadge :value="event.analysisStatus" />
              </div>
              <template v-if="analysis"
                ><p class="detail-description">{{ analysis.summary ?? '模型未提供摘要。' }}</p>
                <div v-if="Array.isArray(analysis.keyFacts)" class="fact-list">
                  <div v-for="(fact, index) in analysis.keyFacts" :key="index">
                    <span class="text-teal">{{ String(index + 1).padStart(2, '0') }}</span>
                    <p>{{ typeof fact === 'object' ? JSON.stringify(fact) : fact }}</p>
                  </div>
                </div>
                <div v-if="analysis.uncertainty" class="notice-box">
                  <RadarIcon name="warning" :size="16" />
                  <p>
                    {{
                      Array.isArray(analysis.uncertainty)
                        ? analysis.uncertainty.join('；')
                        : analysis.uncertainty
                    }}
                  </p>
                </div>
                <div class="muted text-xs">
                  模型 {{ analysis.modelVersion ?? '未知' }} · 提示版本
                  {{ analysis.promptVersion ?? '未知' }} · 模型推断需结合原始证据核验
                </div></template
              >
              <div v-else class="empty-inline">
                暂无 AI 解读。规则与确定性预警持续运行，不依赖模型可用性。
              </div>
            </section>
            <section class="panel detail-panel review-panel">
              <div class="panel-heading">
                <h2>AI 人工复核</h2>
                <span
                  class="badge"
                  :class="
                    event.review?.status === 'APPROVED'
                      ? 'badge-verified'
                      : event.review?.status === 'REJECTED'
                        ? 'badge-failed'
                        : 'badge-unverified'
                  "
                  >{{
                    event.review?.status === 'APPROVED'
                      ? '人工已通过'
                      : event.review?.status === 'REJECTED'
                        ? '人工已驳回'
                        : '等待人工复核'
                  }}</span
                >
              </div>
              <p class="muted text-xs">
                复核仅评审 AI 解读，不改变来源事实的验证状态、机会评分或风险评分。
              </p>
              <div v-if="event.review" class="review-record">
                <p>{{ event.review.note || '未填写复核说明' }}</p>
                <span
                  >复核于 {{ date(event.review.reviewedAt, true) }} ·
                  {{ event.review.reviewerId }}</span
                >
              </div>
              <label for="review-note" class="review-label">复核说明（可选）</label
              ><textarea
                id="review-note"
                v-model="reviewNote"
                maxlength="2000"
                placeholder="记录事实核对、证据缺失或模型推断的问题…"
                class="review-note"
              />
              <div v-if="reviewError" class="form-error" role="alert">{{ reviewError }}</div>
              <div class="review-actions">
                <button class="btn" :disabled="reviewBusy" @click="review('REJECTED')">
                  <RadarIcon name="close" :size="14" />驳回解读</button
                ><button class="btn btn-primary" :disabled="reviewBusy" @click="review('APPROVED')">
                  <RadarIcon name="check" :size="15" />{{ reviewBusy ? '正在保存…' : '通过复核' }}
                </button>
              </div>
            </section>
            <section class="panel detail-panel">
              <div class="panel-heading">
                <h2>来源与证据</h2>
                <span class="muted text-xs">可追溯链路</span>
              </div>
              <DataState :loading="sourcesPending" :error="sourcesError" @retry="refreshSources()">
                <div
                  v-for="(source, index) in sources?.data ?? []"
                  :key="source.id ?? index"
                  class="evidence-row"
                >
                  <span class="evidence-index">{{ String(index + 1).padStart(2, '0') }}</span>
                  <div>
                    <b>{{ source.title ?? source.sourceId ?? '原始来源' }}</b>
                    <p>{{ source.description ?? `原始记录 ${source.rawItemId ?? '未知'}` }}</p>
                    <div class="evidence-times">
                      <span
                        >来源发布
                        {{ date(source.sourcePublishedAt ?? source.publishedAt, true) }}</span
                      >
                      <span>首次发现 {{ date(source.firstSeenAt, true) }}</span>
                      <span>系统采集 {{ date(source.collectedAt, true) }}</span>
                    </div>
                    <a
                      v-if="safeUrl(source.url ?? source.originalUrl)"
                      :href="safeUrl(source.url ?? source.originalUrl)"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-link"
                      >原始链接<RadarIcon name="external" :size="12"
                    /></a>
                    <details v-if="source.payload !== undefined" class="evidence-details">
                      <summary>展开原始 payload</summary>
                      <pre class="json-view evidence-json">{{ jsonText(source.payload) }}</pre>
                    </details>
                  </div>
                </div>
                <p v-if="!sources?.data.length" class="muted">
                  来源标识：{{ event.sourceId }} · 原始数据引用：{{ event.rawDataReference }}
                </p>
              </DataState>
            </section>
          </div>
          <aside class="detail-side">
            <section class="panel detail-panel">
              <h2>独立评估</h2>
              <div class="mt-5"><ScoreBar :value="event.opportunityScore" /></div>
              <div class="mt-5"><ScoreBar :value="event.riskScore" risk /></div>
              <div class="confidence-row">
                <span>证据置信度</span><b>{{ Math.round(event.confidence * 100) }}%</b>
              </div>
              <div v-if="event.riskWarnings?.length" class="notice-box">
                <RadarIcon name="warning" :size="16" />
                <div>
                  <p v-for="warning in event.riskWarnings" :key="warning">{{ warning }}</p>
                </div>
              </div>
            </section>
            <section class="panel detail-panel">
              <h2>时间链路</h2>
              <dl class="time-list">
                <div>
                  <dt>事件发生</dt>
                  <dd>{{ date(event.eventOccurredAt, true) }}</dd>
                </div>
                <div>
                  <dt>来源发布</dt>
                  <dd>{{ date(event.sourcePublishedAt, true) }}</dd>
                </div>
                <div>
                  <dt>首次发现</dt>
                  <dd>{{ date(event.firstSeenAt, true) }}</dd>
                </div>
                <div>
                  <dt>系统采集</dt>
                  <dd>{{ date(event.collectedAt, true) }}</dd>
                </div>
              </dl>
              <p class="muted text-xs">不同时间字段分别记录。未知时间不参与延迟计算。</p>
            </section>
            <details
              v-if="event.metrics || event.chain || event.assetKey"
              class="panel detail-panel evidence-details event-metrics-details"
            >
              <summary>
                <h2>事件指标与身份</h2>
                <RadarIcon name="chevron" :size="15" />
              </summary>
              <dl class="info-list">
                <div v-if="event.chain">
                  <dt>所属公链</dt>
                  <dd>{{ label(event.chain) }}</dd>
                </div>
                <div v-if="event.assetKey">
                  <dt>资产标识</dt>
                  <dd class="mono break-all">{{ event.assetKey }}</dd>
                </div>
                <div v-for="(item, key) in event.metrics ?? {}" :key="key">
                  <dt>{{ label(String(key)) }}</dt>
                  <dd class="mono">{{ item === null ? '未知' : item }}</dd>
                </div>
              </dl>
            </details>
            <details
              v-if="event.opportunityBreakdown || event.riskBreakdown"
              class="panel detail-panel evidence-details event-metrics-details"
            >
              <summary>
                <h2>评分解释</h2>
                <RadarIcon name="chevron" :size="15" />
              </summary>
              <div v-if="event.opportunityBreakdown" class="mt-5">
                <ScoreBar :value="event.opportunityScore" />
                <div
                  v-for="item in breakdown(event.opportunityBreakdown)"
                  :key="`opp-${item.key}`"
                  class="breakdown-row"
                >
                  <span>{{ label(item.key) }}</span
                  ><span>{{ item.value }}</span>
                </div>
              </div>
              <div v-if="event.riskBreakdown" class="mt-5">
                <ScoreBar :value="event.riskScore" risk />
                <div
                  v-for="item in breakdown(event.riskBreakdown)"
                  :key="`risk-${item.key}`"
                  class="breakdown-row"
                >
                  <span>{{ label(item.key) }}</span
                  ><span>{{ item.value }}</span>
                </div>
              </div>
            </details>
          </aside>
        </div></template
      ></DataState
    >
  </div>
</template>
