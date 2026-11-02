<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { SettingsSchema, type UserSettings } from '@radar/shared';
import { ElMessage } from 'element-plus';
import { api, write } from '../lib/api';
import type { Watchlist } from '../lib/models';
import { date, number } from '../lib/format';
import { useAuth } from '../stores/auth';
import { useUi } from '../stores/ui';
import DataState from '../components/DataState.vue';
import RadarIcon from '../components/RadarIcon.vue';
interface SystemStatus {
  version: string;
  commitSha: string;
  dataMode: string;
  asOf: string;
  worker: { online: boolean; lastHeartbeat: string | null };
  queues: Record<string, number | Record<string, number> | null>;
  ai: {
    configured: boolean;
    provider: string;
    model: string;
    dailyBudgetUsd: number;
    usage: { calls: number; inputTokens: number; outputTokens: number; estimatedCost: number };
  };
  keys: Record<string, boolean>;
}
const client = useQueryClient();
const auth = useAuth();
const ui = useUi();
const saving = ref(false);
const watchName = ref('');
const newAsset = reactive<Record<string, string>>({});
const scoringDraft = ref('');
const scoringBusy = ref(false);
const scoringSaveError = ref('');
const scoringEdited = ref(false);
const {
  data: scoring,
  isPending: scoringPending,
  error: scoringError,
  refetch: refreshScoring,
} = useQuery({ queryKey: ['scoring-config'], queryFn: () => api<unknown>('/system/scoring') });
watch(
  scoring,
  (value) => {
    if (value && !scoringEdited.value) scoringDraft.value = JSON.stringify(value.data, null, 2);
  },
  { immediate: true },
);
const {
  data: status,
  isPending,
  error,
  refetch,
} = useQuery({ queryKey: ['system-status'], queryFn: () => api<SystemStatus>('/system/status') });
const { data: settings, error: settingsError } = useQuery({
  queryKey: ['settings'],
  queryFn: () => api('/settings', {}, SettingsSchema),
});
const {
  data: lists,
  error: listsError,
  refetch: refreshLists,
} = useQuery({ queryKey: ['watchlists'], queryFn: () => api<Watchlist[]>('/watchlists') });
interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
}
const auditSearch = ref('');
const {
  data: audit,
  error: auditError,
  refetch: refreshAudit,
} = useQuery({
  queryKey: ['audit-logs'],
  queryFn: () => api<AuditEntry[]>('/system/logs?pageSize=50'),
});
const filteredAudit = computed(
  () =>
    audit.value?.data.filter((item) =>
      `${item.action} ${item.entityType} ${item.entityId ?? ''}`
        .toLowerCase()
        .includes(auditSearch.value.toLowerCase()),
    ) ?? [],
);
const form = reactive<UserSettings>({
  theme: ui.theme as 'dark' | 'light',
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  notifications: { quietStart: null, quietEnd: null, minimumPriority: 'P2' },
});
watch(
  settings,
  (value) => {
    if (value) Object.assign(form, SettingsSchema.parse(value.data));
  },
  { immediate: true },
);
const system = computed(() => status.value?.data);
const keyLabels: Record<string, string> = {
  telegram: 'Telegram Bot',
  github: 'GitHub Token',
  unisat: 'UniSat',
  evmRpc: 'EVM RPC',
  solanaRpc: 'Solana RPC',
};
async function save() {
  saving.value = true;
  try {
    await write('/settings', 'PATCH', SettingsSchema.parse(form));
    if (form.theme !== 'system') ui.theme = form.theme;
    else ui.theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    await client.invalidateQueries({ queryKey: ['settings'] });
    ElMessage.success('个人设置已保存');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败');
  } finally {
    saving.value = false;
  }
}
async function saveScoring() {
  scoringBusy.value = true;
  scoringSaveError.value = '';
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(scoringDraft.value);
    } catch {
      throw new Error('JSON 格式无效，请检查括号、引号与逗号。');
    }
    await write('/system/scoring', 'PATCH', parsed);
    scoringEdited.value = false;
    await client.invalidateQueries({ queryKey: ['scoring-config'] });
    ElMessage.success('评分配置新版本已保存，历史评分保留原版本');
  } catch (err) {
    scoringSaveError.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    scoringBusy.value = false;
  }
}
async function addList() {
  if (!watchName.value.trim()) return;
  try {
    await write('/watchlists', 'POST', { name: watchName.value.trim() });
    watchName.value = '';
    await client.invalidateQueries({ queryKey: ['watchlists'] });
    ElMessage.success('观察列表已创建');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '创建失败');
  }
}
async function addAsset(id: string) {
  const assetKey = newAsset[id]?.trim();
  if (!assetKey) return;
  try {
    await write(`/watchlists/${id}/items`, 'POST', { assetKey });
    newAsset[id] = '';
    await client.invalidateQueries({ queryKey: ['watchlists'] });
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败');
  }
}
async function removeAsset(id: string, assetKey: string) {
  try {
    await write(`/watchlists/${id}/items/${encodeURIComponent(assetKey)}`, 'DELETE');
    await client.invalidateQueries({ queryKey: ['watchlists'] });
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败');
  }
}
function queueTotal(value: number | Record<string, number> | null | undefined) {
  return typeof value === 'number'
    ? value
    : value
      ? Object.values(value).reduce((sum, count) => sum + count, 0)
      : null;
}
</script>
<template>
  <div class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">SYSTEM CONSOLE</div>
        <h1>系统管理<span class="title-dot">.</span></h1>
        <p>运行状态、分析成本与个人偏好，尽在掌握。</p>
      </div>
      <button class="btn" @click="refetch()">
        <RadarIcon name="refresh" :size="15" />刷新状态
      </button>
    </div>
    <DataState :loading="isPending" :error="error" @retry="refetch()"
      ><template v-if="system"
        ><div class="system-overview">
          <section class="panel system-service">
            <div class="panel-heading">
              <h2>服务版本</h2>
              <RadarIcon name="code" :size="17" />
            </div>
            <strong class="system-big-value">{{ system.version }}</strong>
            <p class="mono muted">{{ system.commitSha?.slice(0, 12) ?? 'unknown' }}</p>
            <span class="badge">{{
              system.dataMode === 'fixture' ? 'Fixture 演练模式' : '真实来源模式'
            }}</span>
          </section>
          <section class="panel system-service">
            <div class="panel-heading">
              <h2>Worker</h2>
              <span class="status-dot" :class="{ offline: !system.worker?.online }" />
            </div>
            <strong
              class="system-big-value"
              :class="system.worker?.online ? 'text-teal' : 'text-amber'"
              >{{ system.worker?.online ? '在线' : '离线' }}</strong
            >
            <p class="muted text-xs">最近心跳 {{ date(system.worker?.lastHeartbeat) }}</p>
            <span class="muted text-xs">独立进程 · 可恢复任务队列</span>
          </section>
          <section class="panel system-service">
            <div class="panel-heading">
              <h2>队列积压</h2>
              <RadarIcon name="source" :size="17" />
            </div>
            <div class="queue-counts">
              <div v-for="(value, key) in system.queues" :key="key">
                <b>{{ number(queueTotal(value)) }}</b
                ><span>{{
                  { ingestion: '采集', analysis: '分析', notifications: '通知' }[key] ?? key
                }}</span>
              </div>
            </div>
            <p class="muted text-xs">采集、分析、发送独立执行</p>
          </section>
        </div>
        <div class="settings-grid">
          <section class="panel detail-panel">
            <div class="panel-heading">
              <h2>AI 分析与成本</h2>
              <span
                class="badge"
                :class="system.ai?.configured ? 'badge-healthy' : 'badge-unknown'"
                >{{ system.ai?.configured ? '已配置' : '未配置 · 规则持续运行' }}</span
              >
            </div>
            <dl class="info-list">
              <div>
                <dt>Provider / 模型</dt>
                <dd>{{ system.ai?.provider ?? '未知' }} / {{ system.ai?.model ?? '未知' }}</dd>
              </div>
              <div>
                <dt>每日预算</dt>
                <dd class="mono">$ {{ number(system.ai?.dailyBudgetUsd, 2) }}</dd>
              </div>
              <div>
                <dt>今日调用</dt>
                <dd class="mono">{{ number(system.ai?.usage?.calls) }} 次</dd>
              </div>
              <div>
                <dt>输入 / 输出 Token</dt>
                <dd class="mono">
                  {{ number(system.ai?.usage?.inputTokens) }} /
                  {{ number(system.ai?.usage?.outputTokens) }}
                </dd>
              </div>
              <div>
                <dt>估算成本</dt>
                <dd class="mono">$ {{ number(system.ai?.usage?.estimatedCost, 4) }}</dd>
              </div>
            </dl>
            <p class="muted text-xs">
              AI 为异步辅助分析，超时、预算不足或不可用时，采集与确定性规则继续工作。
            </p>
          </section>
          <section class="panel detail-panel">
            <div class="panel-heading">
              <h2>凭据配置状态</h2>
              <RadarIcon name="shield" :size="17" />
            </div>
            <div v-for="(configured, key) in system.keys" :key="key" class="key-status-row">
              <span>{{ keyLabels[key] ?? key }}</span
              ><span class="badge" :class="configured ? 'badge-healthy' : 'badge-unknown'">{{
                configured ? '已配置' : '未配置'
              }}</span>
            </div>
            <p class="muted text-xs mt-5">
              完整密钥只保存在服务器环境。修改与轮换后需重启对应服务。
            </p>
          </section>
        </div></template
      ></DataState
    >
    <div class="settings-grid">
      <section class="panel detail-panel">
        <div class="panel-heading">
          <h2>个人设置</h2>
          <span class="muted text-xs">{{ auth.user?.email }}</span>
        </div>
        <div v-if="settingsError" class="form-error">{{ settingsError.message }}</div>
        <form v-else class="form-grid" @submit.prevent="save">
          <div class="form-field">
            <label for="settings-theme">界面主题</label
            ><select id="settings-theme" v-model="form.theme">
              <option value="dark">深色</option>
              <option value="light">浅色</option>
              <option value="system">跟随系统</option>
            </select>
          </div>
          <div class="form-field">
            <label for="settings-zone">显示时区</label
            ><select id="settings-zone" v-model="form.timezone">
              <option>Asia/Shanghai</option>
              <option>UTC</option>
              <option>America/New_York</option>
              <option>Europe/London</option>
              <option>Asia/Tokyo</option>
            </select>
          </div>
          <div class="form-field">
            <label for="settings-priority">最低通知级别</label
            ><select id="settings-priority" v-model="form.notifications.minimumPriority">
              <option v-for="value in ['P0', 'P1', 'P2', 'P3']" :key="value" :value="value">
                {{ value }}
              </option>
            </select>
          </div>
          <div class="form-field">
            <label for="settings-quiet-start">免打扰开始</label
            ><select id="settings-quiet-start" v-model="form.notifications.quietStart">
              <option :value="null">不启用</option>
              <option v-for="hour in 24" :key="hour" :value="hour - 1">
                {{ String(hour - 1).padStart(2, '0') }}:00
              </option>
            </select>
          </div>
          <div class="form-field">
            <label for="settings-quiet-end">免打扰结束</label
            ><select id="settings-quiet-end" v-model="form.notifications.quietEnd">
              <option :value="null">不启用</option>
              <option v-for="hour in 24" :key="hour" :value="hour - 1">
                {{ String(hour - 1).padStart(2, '0') }}:00
              </option>
            </select>
          </div>
          <div class="form-field settings-submit">
            <button class="btn btn-primary" type="submit" :disabled="saving || !settings">
              {{ saving ? '保存中…' : '保存设置' }}
            </button>
          </div>
        </form>
      </section>
      <section class="panel detail-panel">
        <div class="panel-heading">
          <h2>观察列表</h2>
          <RadarIcon name="eye" :size="17" />
        </div>
        <DataState :error="listsError" @retry="refreshLists()"
          ><form class="inline-form" @submit.prevent="addList">
            <input
              v-model="watchName"
              aria-label="新观察列表名称"
              placeholder="新观察列表名称"
              maxlength="100"
              required
            /><button class="btn" type="submit"><RadarIcon name="plus" :size="15" />创建</button>
          </form>
          <div v-for="list in lists?.data" :key="list.id" class="watchlist">
            <h3>
              {{ list.name }}<span class="muted text-xs">{{ list.items?.length ?? 0 }} 个资产</span>
            </h3>
            <div class="watchlist-items">
              <span
                v-for="item in list.items ?? []"
                :key="item.id ?? item.assetKey"
                class="asset-chip"
                >{{ item.assetKey
                }}<button
                  class="icon-btn"
                  :aria-label="`移除${item.assetKey}`"
                  @click="removeAsset(list.id, item.assetKey ?? '')"
                >
                  <RadarIcon name="close" :size="12" /></button></span
              ><span v-if="!list.items?.length" class="muted text-xs"
                >暂无资产，可在项目详情加入或手动添加。</span
              >
            </div>
            <form class="inline-form" @submit.prevent="addAsset(list.id)">
              <input
                v-model="newAsset[list.id]"
                :aria-label="`添加资产到${list.name}`"
                placeholder="资产标识，例如 BTC"
                maxlength="200"
                required
              /><button class="btn" type="submit">添加</button>
            </form>
          </div>
          <p v-if="!lists?.data.length" class="muted text-xs mt-5">
            还没有观察列表，创建后可持续追踪感兴趣的资产。
          </p></DataState
        >
      </section>
    </div>
    <section class="panel section-block">
      <div class="panel-heading">
        <h2>操作审计</h2>
        <button class="text-link" @click="refreshAudit()">
          <RadarIcon name="refresh" :size="13" />刷新日志
        </button>
      </div>
      <div class="audit-search">
        <input
          v-model="auditSearch"
          aria-label="查询审计日志"
          placeholder="在最近 50 条记录中搜索操作、实体或 ID…"
          maxlength="200"
        />
      </div>
      <DataState
        :error="auditError"
        :empty="filteredAudit.length === 0"
        empty-text="暂无匹配的审计记录"
        @retry="refreshAudit()"
        ><div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>实体</th>
                <th>标识</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in filteredAudit" :key="entry.id">
                <td>{{ date(entry.createdAt) }}</td>
                <td>{{ entry.action }}</td>
                <td>{{ entry.entityType }}</td>
                <td class="mono">{{ entry.entityId ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div></DataState
      >
    </section>
    <details class="panel advanced-panel section-block">
      <summary>
        <span><RadarIcon name="rules" :size="17" />高级评分配置</span
        ><span class="muted text-xs">机会与风险权重 · 版本化 JSON</span
        ><RadarIcon name="chevron" :size="15" />
      </summary>
      <div class="advanced-body">
        <p class="muted text-xs">
          修改对应权重时，必须同时修改该部分
          version。已使用的版本不可覆盖；字段与权重范围由服务端严格校验。
        </p>
        <DataState :loading="scoringPending" :error="scoringError" @retry="refreshScoring()"
          ><form @submit.prevent="saveScoring">
            <label for="scoring-json" class="sr-only">评分配置 JSON</label
            ><textarea
              id="scoring-json"
              v-model="scoringDraft"
              class="scoring-editor"
              spellcheck="false"
              @input="scoringEdited = true"
            />
            <div v-if="scoringSaveError" class="form-error" role="alert">
              {{ scoringSaveError }}
            </div>
            <div class="scoring-actions">
              <span class="muted text-xs">原始证据与历史评分不会被新版本覆盖。</span
              ><button
                class="btn btn-primary"
                type="submit"
                :disabled="scoringBusy || !scoringEdited"
              >
                {{ scoringBusy ? '正在保存…' : '保存评分新版本' }}
              </button>
            </div>
          </form></DataState
        >
      </div>
    </details>
  </div>
</template>
