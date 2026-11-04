<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { z } from 'zod';
import {
  SourceSchema,
  SourceCatalogSchema,
  SourceInputSchema,
  MarketSourceMinimumIntervals,
  type DataSource,
} from '@radar/shared';
import { ElMessage } from 'element-plus';
import { api, write } from '../lib/api';
import { date, label, number, relative, safeUrl } from '../lib/format';
import DataState from '../components/DataState.vue';
import RadarIcon from '../components/RadarIcon.vue';
import StatusBadge from '../components/StatusBadge.vue';
import SourcesIntegrationPanel from '../components/SourcesIntegrationPanel.vue';
interface HealthRecord {
  id: string;
  status: string;
  latencyMs: number | null;
  error: string | null;
  observedAt: string;
}
const client = useQueryClient();
const selected = ref<DataSource | null>(null);
const healthOpen = ref(false);
const interval = ref(60);
const busy = ref(false);
const addOpen = ref(false);
const addBusy = ref(false);
const addError = ref('');
const category = ref('');
const categoryLabels: Record<string, string> = {
  macro: '宏观政策',
  finance: '财经市场',
  technology: '科技动态',
  world: '全球热点',
  crypto: '加密资产',
};
const feed = reactive({
  name: '',
  feedUrl: '',
  categories: ['finance'],
  intervalSeconds: 300,
  enabled: true,
});
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['sources'],
  queryFn: () => api('/sources', {}, z.array(SourceSchema)),
});
const {
  data: catalog,
  isPending: catalogPending,
  error: catalogError,
  refetch: refreshCatalog,
} = useQuery({
  queryKey: ['source-catalog'],
  queryFn: () => api('/sources/catalog', {}, z.array(SourceCatalogSchema)),
});
const live = computed(
  () => (data.value?.meta?.dataMode ?? catalog.value?.meta?.dataMode) === 'live',
);
const filteredSources = computed(
  () =>
    data.value?.data.filter(
      (source) => !category.value || source.categories.includes(category.value),
    ) ?? [],
);
const filteredCatalog = computed(
  () =>
    catalog.value?.data.filter(
      (source) => !category.value || source.categories.includes(category.value),
    ) ?? [],
);
const {
  data: health,
  isPending: healthPending,
  error: healthError,
  refetch: refreshHealth,
} = useQuery({
  queryKey: ['source-health', computed(() => selected.value?.id)],
  queryFn: () => api<HealthRecord[]>(`/sources/${selected.value?.id}/health`),
  enabled: computed(() => Boolean(selected.value)),
});
const healthy = computed(
  () =>
    data.value?.data.filter((source) => ['healthy', 'HEALTHY'].includes(source.status)).length ?? 0,
);
async function toggle(source: DataSource) {
  try {
    await write(`/sources/${source.id}`, 'PATCH', { enabled: !source.enabled });
    await client.invalidateQueries({ queryKey: ['sources'] });
    await client.invalidateQueries({ queryKey: ['source-catalog'] });
    ElMessage.success(source.enabled ? '数据源已停用' : '数据源已启用');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败');
  }
}
async function toggleCatalog(source: z.infer<typeof SourceCatalogSchema>) {
  try {
    await write(`/sources/${source.id}`, 'PATCH', { enabled: !source.enabled });
    await client.invalidateQueries({ queryKey: ['sources'] });
    await client.invalidateQueries({ queryKey: ['source-catalog'] });
    ElMessage.success(source.enabled ? '数据源已停用' : '数据源已启用');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败');
  }
}
async function addFeed() {
  addBusy.value = true;
  addError.value = '';
  try {
    const input = SourceInputSchema.safeParse(feed);
    if (!input.success)
      throw new Error(
        '请填写名称、无查询参数或片段的 HTTPS 订阅地址，至少选择一个分类，轮询周期不少于 60 秒。',
      );
    await write('/sources', 'POST', input.data);
    addOpen.value = false;
    Object.assign(feed, {
      name: '',
      feedUrl: '',
      categories: ['finance'],
      intervalSeconds: 300,
      enabled: true,
    });
    await client.invalidateQueries({ queryKey: ['sources'] });
    await client.invalidateQueries({ queryKey: ['source-catalog'] });
    ElMessage.success('新闻订阅已添加，Worker 将按轮询计划采集');
  } catch (err) {
    addError.value = err instanceof Error ? err.message : '添加失败';
  } finally {
    addBusy.value = false;
  }
}
function inspect(source: DataSource) {
  selected.value = source;
  interval.value = source.intervalSeconds;
  healthOpen.value = true;
}
async function saveInterval() {
  if (!selected.value) return;
  busy.value = true;
  try {
    await write(`/sources/${selected.value.id}`, 'PATCH', {
      intervalSeconds: Number(interval.value),
    });
    await client.invalidateQueries({ queryKey: ['sources'] });
    ElMessage.success('轮询周期已更新');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="page sources-page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">SOURCE NETWORK</div>
        <h1>数据源<span class="title-dot">.</span></h1>
        <p>看清信息从哪里来，多久更新，以及当前是否可信可用。</p>
      </div>
      <div class="integration-button-group">
        <button
          class="btn"
          @click="
            refetch();
            refreshCatalog();
          "
        >
          <RadarIcon name="refresh" :size="15" />刷新状态</button
        ><button
          class="btn btn-primary"
          :disabled="!live"
          @click="
            addError = '';
            addOpen = true;
          "
        >
          <RadarIcon name="plus" :size="15" />新增新闻订阅
        </button>
      </div>
    </div>
    <SourcesIntegrationPanel />
    <div class="source-category-filter" aria-label="数据源分类">
      <button :class="{ active: !category }" :aria-pressed="!category" @click="category = ''">
        全部来源
      </button>
      <button
        v-for="(name, key) in categoryLabels"
        :key="key"
        :class="{ active: category === key }"
        :aria-pressed="category === key"
        @click="category = key"
      >
        {{ name }}
      </button>
    </div>
    <div class="summary-strip">
      <span
        ><b>{{ number(data?.data.length) }}</b> 个已注册数据源</span
      ><span
        ><span class="status-dot" /><b>{{ healthy }}</b> 个健康连接</span
      ><span>启用状态与健康状态分别记录</span>
    </div>
    <DataState
      :loading="isPending"
      :error="error"
      :empty="filteredSources.length === 0"
      empty-text="当前分类尚无已注册数据源，可查看下方来源目录"
      @retry="refetch()"
      ><div class="source-grid">
        <section v-for="source in filteredSources" :key="source.id" class="panel source-card">
          <div class="source-card-top">
            <span class="source-avatar"
              ><RadarIcon
                :name="
                  source.connectorType === 'fixture'
                    ? 'code'
                    : source.capabilities.some((value) => value.includes('market'))
                      ? 'chart'
                      : 'source'
                "
                :size="23"
            /></span>
            <div>
              <h2>{{ source.name }}</h2>
              <span>{{ source.connectorType }} · {{ source.id }}</span>
            </div>
            <el-switch
              :model-value="source.enabled"
              :aria-label="`${source.name}启用状态`"
              @change="toggle(source)"
            />
          </div>
          <p class="source-description">
            {{ source.description || '统一 Connector 管理采集、归一化、健康检查与恢复。' }}
          </p>
          <div class="project-tags">
            <StatusBadge :value="source.enabled ? source.status : 'DISABLED'" /><StatusBadge
              v-if="source.mode === 'fixture'"
              value="fixture"
            /><span v-for="value in source.categories" :key="value" class="badge">{{
              categoryLabels[value] ?? value
            }}</span
            ><span class="badge">{{ source.delayLabel }}</span>
          </div>
          <dl class="source-stats">
            <div>
              <dt>最近成功</dt>
              <dd :title="date(source.lastSuccessAt, true)">
                {{ source.lastSuccessAt ? relative(source.lastSuccessAt) : '尚无成功记录' }}
              </dd>
            </div>
            <div>
              <dt>成功率</dt>
              <dd>
                {{
                  source.successRate === null
                    ? '暂无样本'
                    : `${number(source.successRate * 100, 1)}%`
                }}
              </dd>
            </div>
            <div>
              <dt>轮询周期</dt>
              <dd>{{ number(source.intervalSeconds) }} 秒</dd>
            </div>
            <div>
              <dt>请求延迟</dt>
              <dd>{{ source.latencyMs === null ? '未知' : `${number(source.latencyMs)} ms` }}</dd>
            </div>
          </dl>
          <p v-if="source.lastError" class="source-error">
            <RadarIcon name="warning" :size="13" />{{ source.lastError }}
          </p>
          <div class="source-card-foot">
            <span>下次计划 {{ source.nextPollAt ? date(source.nextPollAt) : '尚未安排' }}</span
            ><button class="text-link" @click="inspect(source)">
              健康记录<RadarIcon name="arrow" :size="14" />
            </button>
          </div>
        </section></div
    ></DataState>
    <section
      class="panel detail-panel source-catalog-panel"
      aria-labelledby="source-catalog-heading"
    >
      <div class="panel-heading">
        <div>
          <span class="section-number">＋</span>
          <h2 id="source-catalog-heading">来源目录</h2>
        </div>
        <span class="muted text-xs">宏观 · 财经 · 科技 · 全球热点</span>
      </div>
      <p class="muted source-catalog-intro">
        内置来源在 live Worker 启动后注册。你也可以添加有权使用的公共 RSS / Atom
        订阅，新闻进入热点与规则处理流程。
      </p>
      <p v-if="!live" class="integration-mode-note">
        当前为 Fixture 演练模式：可浏览真实来源目录；添加订阅与真实采集需要部署切换至
        DATA_MODE=live。
      </p>
      <DataState
        :loading="catalogPending"
        :error="catalogError"
        :empty="filteredCatalog.length === 0"
        empty-text="当前分类暂无内置来源"
        @retry="refreshCatalog()"
      >
        <div class="source-catalog-list">
          <article v-for="source in filteredCatalog" :key="source.id" class="source-catalog-row">
            <div class="source-catalog-identity">
              <h3>{{ source.name }}</h3>
              <div class="project-tags">
                <span v-for="value in source.categories" :key="value" class="badge">{{
                  categoryLabels[value] ?? value
                }}</span
                ><span v-if="source.requiresConfiguration" class="badge badge-unknown"
                  >需配置接入</span
                >
              </div>
            </div>
            <div class="source-catalog-description">
              <p>{{ source.description }}</p>
              <span>{{ source.licenseStatus }} · {{ source.intervalSeconds }} 秒轮询</span>
            </div>
            <div class="source-catalog-actions">
              <a
                v-if="safeUrl(source.docsUrl)"
                class="text-link"
                :href="safeUrl(source.docsUrl)"
                target="_blank"
                rel="noopener noreferrer"
                >来源说明<RadarIcon name="external" :size="12" /></a
              ><button
                v-if="live && source.installed"
                class="text-link"
                @click="toggleCatalog(source)"
              >
                {{ source.enabled ? '停用来源' : '启用来源' }}</button
              ><span v-else class="muted text-xs">{{
                live ? '等待 Worker 注册' : 'Live 来源'
              }}</span>
            </div>
          </article>
        </div>
      </DataState>
    </section>
    <div class="research-notice">
      <RadarIcon name="shield" :size="17" />
      <p>
        未配置密钥的数据源不会伪装在线。限流、超时与熔断会保留错误记录，恢复后继续使用已有游标。
      </p>
    </div>
    <el-dialog
      v-model="addOpen"
      title="新增新闻订阅"
      width="640px"
      align-center
      append-to-body
      :close-on-click-modal="false"
    >
      <form class="form-grid integration-form" @submit.prevent="addFeed">
        <p class="muted full">
          支持 RSS 2.0 / Atom。保存原标题、摘要、原文链接与来源时间，供个人研究使用。
        </p>
        <div class="form-field full">
          <label for="feed-name">订阅名称</label
          ><input
            id="feed-name"
            v-model="feed.name"
            maxlength="100"
            placeholder="例如：财经与政策观察"
            required
          />
        </div>
        <div class="form-field full">
          <label for="feed-url">RSS / Atom 地址</label
          ><input
            id="feed-url"
            v-model="feed.feedUrl"
            type="url"
            required
            placeholder="https://news.example.com/feed.xml"
          /><span class="field-hint"
            >仅限不含凭据、查询参数或片段的公开 HTTPS
            订阅；地址保存后不可替换，变更时请新建来源。</span
          >
        </div>
        <fieldset class="integration-fieldset full">
          <legend>内容分类（至少选择一项）</legend>
          <div class="checkbox-list">
            <label v-for="(name, key) in categoryLabels" :key="key"
              ><input v-model="feed.categories" type="checkbox" :value="key" />{{ name }}</label
            >
          </div>
        </fieldset>
        <div class="form-field">
          <label for="feed-interval">新闻轮询周期（秒）</label
          ><input
            id="feed-interval"
            v-model.number="feed.intervalSeconds"
            type="number"
            min="60"
            max="86400"
            required
          /><span class="field-hint">建议 300 秒或更长，遵守来源的更新周期与使用条款。</span>
        </div>
        <div class="form-field">
          <label for="feed-enabled">保存后状态</label
          ><select id="feed-enabled" v-model="feed.enabled">
            <option :value="true">启用采集</option>
            <option :value="false">暂不采集</option>
          </select>
        </div>
        <p v-if="addError" class="form-error full" role="alert">{{ addError }}</p>
        <div class="dialog-actions full">
          <button class="btn" type="button" :disabled="addBusy" @click="addOpen = false">
            取消</button
          ><button class="btn btn-primary" type="submit" :disabled="addBusy || !live">
            {{ addBusy ? '添加中…' : '添加订阅' }}
          </button>
        </div>
      </form>
    </el-dialog>
    <el-dialog
      v-model="healthOpen"
      :title="selected?.name ?? '数据源健康'"
      width="720px"
      align-center
      append-to-body
      ><template v-if="selected"
        ><p class="muted">{{ selected.description }}</p>
        <div class="source-config-row">
          <label for="source-interval">轮询周期（秒）</label
          ><input
            id="source-interval"
            v-model="interval"
            type="number"
            :min="MarketSourceMinimumIntervals[selected.id] ?? (selected.custom ? 60 : 10)"
            max="86400"
          /><button class="btn btn-primary" :disabled="busy" @click="saveInterval">保存周期</button
          ><a
            v-if="safeUrl(selected.docsUrl)"
            :href="safeUrl(selected.docsUrl)"
            class="text-link"
            target="_blank"
            rel="noopener noreferrer"
            >官方文档<RadarIcon name="external" :size="13"
          /></a>
        </div>
        <p v-if="selected.feedUrl" class="source-feed-url muted">
          订阅地址：{{ selected.feedUrl }}
        </p>
        <div class="project-tags">
          <span v-for="capability in selected.capabilities" :key="capability" class="badge">{{
            label(capability)
          }}</span
          ><span class="badge">密钥{{ selected.keyConfigured ? '已配置' : '未配置或不需要' }}</span>
        </div>
        <DataState
          :loading="healthPending"
          :error="healthError"
          :empty="health?.data.length === 0"
          empty-text="暂无健康检查记录"
          @retry="refreshHealth()"
          ><div class="table-scroll mt-5">
            <table class="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>状态</th>
                  <th>延迟</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="record in health?.data" :key="record.id">
                  <td>{{ date(record.observedAt) }}</td>
                  <td><StatusBadge :value="record.status" /></td>
                  <td>{{ number(record.latencyMs) }} ms</td>
                  <td>{{ record.error ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div></DataState
        ></template
      ></el-dialog
    >
  </div>
</template>
