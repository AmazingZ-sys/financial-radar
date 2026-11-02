<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { z } from 'zod';
import { SourceSchema, type DataSource } from '@radar/shared';
import { ElMessage } from 'element-plus';
import { api, write } from '../lib/api';
import { date, label, number, relative, safeUrl } from '../lib/format';
import DataState from '../components/DataState.vue';
import RadarIcon from '../components/RadarIcon.vue';
import StatusBadge from '../components/StatusBadge.vue';
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
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['sources'],
  queryFn: () => api('/sources', {}, z.array(SourceSchema)),
});
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
    ElMessage.success(source.enabled ? '数据源已停用' : '数据源已启用');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败');
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
  <div class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">SOURCE NETWORK</div>
        <h1>数据源<span class="title-dot">.</span></h1>
        <p>看清信息从哪里来，多久更新，以及当前是否可信可用。</p>
      </div>
      <button class="btn" @click="refetch()">
        <RadarIcon name="refresh" :size="15" />刷新状态
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
      :empty="data?.data.length === 0"
      empty-text="尚未注册数据源"
      @retry="refetch()"
      ><div class="source-grid">
        <section v-for="source in data?.data" :key="source.id" class="panel source-card">
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
            /><span class="badge">{{ source.delayLabel }}</span>
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
    <div class="research-notice">
      <RadarIcon name="shield" :size="17" />
      <p>
        未配置密钥的数据源不会伪装在线。限流、超时与熔断会保留错误记录，恢复后继续使用已有游标。
      </p>
    </div>
    <el-dialog
      v-model="healthOpen"
      :title="selected?.name ?? '数据源健康'"
      width="720px"
      align-center
      ><template v-if="selected"
        ><p class="muted">{{ selected.description }}</p>
        <div class="source-config-row">
          <label for="source-interval">轮询周期（秒）</label
          ><input
            id="source-interval"
            v-model="interval"
            type="number"
            min="10"
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
