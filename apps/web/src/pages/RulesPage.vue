<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { z } from 'zod';
import { ChannelSchema, RuleInputSchema, RuleSchema, type AlertRule } from '@radar/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, write } from '../lib/api';
import { date, number } from '../lib/format';
import DataState from '../components/DataState.vue';
import RadarIcon from '../components/RadarIcon.vue';
interface AlertTrigger {
  id: string;
  ruleId: string;
  ruleVersion: number;
  eventId: string | null;
  detectedAt: string;
  reason: unknown;
  priority: string | null;
}
const client = useQueryClient();
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['rules'],
  queryFn: () => api('/alert-rules', {}, z.array(RuleSchema)),
});
const { data: channels } = useQuery({
  queryKey: ['channels'],
  queryFn: () => api('/notification-channels', {}, z.array(ChannelSchema)),
});
const {
  data: triggers,
  error: triggersError,
  refetch: refreshTriggers,
} = useQuery({
  queryKey: ['alert-triggers'],
  queryFn: () => api<AlertTrigger[]>('/alerts?pageSize=30'),
});
const dialog = ref(false);
const editingId = ref('');
const busy = ref(false);
const formError = ref('');
const testResult = ref<Record<string, unknown> | null>(null);
const testTitle = ref('');
const testOpen = ref(false);
const form = reactive({
  name: '',
  enabled: true,
  priority: 'P1',
  minConfidence: 70,
  minOpportunityScore: 65,
  maxRiskScore: 60,
  minParticipantGrowthPct: 0,
  minMintProgress: 0,
  maxMintProgress: 100,
  minPriceChangePct: 0,
  minYieldChangeBps: 0,
  verifiedOnly: false,
  assets: '',
  categories: '',
  sourceIds: '',
  chains: '',
  stages: '',
  eventTypes: '',
  cooldownSeconds: 3600,
  windowSeconds: 3600,
  channelIds: [] as string[],
});
const activeCount = computed(() => data.value?.data.filter((rule) => rule.enabled).length ?? 0);
function edit(rule?: AlertRule) {
  editingId.value = rule?.id ?? '';
  formError.value = '';
  Object.assign(form, {
    name: rule?.name ?? '',
    enabled: rule?.enabled ?? true,
    priority: rule?.priority ?? 'P1',
    minConfidence: (rule?.conditions.minConfidence ?? 0.7) * 100,
    minOpportunityScore: rule?.conditions.minOpportunityScore ?? 65,
    maxRiskScore: rule?.conditions.maxRiskScore ?? 60,
    minParticipantGrowthPct: rule?.conditions.minParticipantGrowthPct ?? 0,
    minMintProgress: rule?.conditions.minMintProgress ?? 0,
    maxMintProgress: rule?.conditions.maxMintProgress ?? 100,
    minPriceChangePct: rule?.conditions.minPriceChangePct ?? 0,
    minYieldChangeBps: rule?.conditions.minYieldChangeBps ?? 0,
    verifiedOnly: rule?.conditions.verifiedOnly ?? false,
    assets: rule?.conditions.assets?.join(', ') ?? '',
    categories: rule?.conditions.categories?.join(', ') ?? '',
    sourceIds: rule?.conditions.sourceIds?.join(', ') ?? '',
    chains: rule?.conditions.chains?.join(', ') ?? '',
    stages: rule?.conditions.stages?.join(', ') ?? '',
    eventTypes: rule?.conditions.eventTypes?.join(', ') ?? '',
    cooldownSeconds: rule?.cooldownSeconds ?? 3600,
    windowSeconds: rule?.conditions.windowSeconds ?? 3600,
    channelIds: [...(rule?.channelIds ?? [])],
  });
  dialog.value = true;
}
const split = (value: string) =>
  value
    .split(/[,，]/)
    .map((v) => v.trim())
    .filter(Boolean);
async function save() {
  busy.value = true;
  formError.value = '';
  try {
    const payload = RuleInputSchema.parse({
      name: form.name,
      enabled: form.enabled,
      priority: form.priority,
      cooldownSeconds: Number(form.cooldownSeconds),
      channelIds: form.channelIds,
      conditions: {
        minConfidence: Number(form.minConfidence) / 100,
        minOpportunityScore: Number(form.minOpportunityScore),
        maxRiskScore: Number(form.maxRiskScore),
        ...(Number(form.minParticipantGrowthPct) > 0
          ? { minParticipantGrowthPct: Number(form.minParticipantGrowthPct) }
          : {}),
        ...(Number(form.minMintProgress) > 0
          ? { minMintProgress: Number(form.minMintProgress) }
          : {}),
        ...(Number(form.maxMintProgress) < 100
          ? { maxMintProgress: Number(form.maxMintProgress) }
          : {}),
        ...(Number(form.minPriceChangePct) > 0
          ? { minPriceChangePct: Number(form.minPriceChangePct) }
          : {}),
        ...(Number(form.minYieldChangeBps) > 0
          ? { minYieldChangeBps: Number(form.minYieldChangeBps) }
          : {}),
        verifiedOnly: form.verifiedOnly,
        windowSeconds: Number(form.windowSeconds),
        ...(form.assets ? { assets: split(form.assets) } : {}),
        ...(form.categories ? { categories: split(form.categories) } : {}),
        ...(form.sourceIds ? { sourceIds: split(form.sourceIds) } : {}),
        ...(form.chains ? { chains: split(form.chains) } : {}),
        ...(form.stages ? { stages: split(form.stages) } : {}),
        ...(form.eventTypes ? { eventTypes: split(form.eventTypes) } : {}),
      },
    });
    if (Number(form.minMintProgress) > Number(form.maxMintProgress))
      throw new Error('铸造进度下限不能高于上限。');
    await write(
      editingId.value ? `/alert-rules/${editingId.value}` : '/alert-rules',
      editingId.value ? 'PATCH' : 'POST',
      payload,
    );
    await client.invalidateQueries({ queryKey: ['rules'] });
    dialog.value = false;
    ElMessage.success(editingId.value ? '规则已更新' : '规则已创建');
  } catch (err) {
    formError.value =
      err instanceof z.ZodError
        ? err.issues.map((issue) => issue.message).join('；')
        : err instanceof Error
          ? err.message
          : '保存失败';
  } finally {
    busy.value = false;
  }
}
async function toggle(rule: AlertRule) {
  try {
    await write(`/alert-rules/${rule.id}`, 'PATCH', { enabled: !rule.enabled });
    await client.invalidateQueries({ queryKey: ['rules'] });
    ElMessage.success(rule.enabled ? '规则已停用' : '规则已启用');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败');
  }
}
async function remove(rule: AlertRule) {
  try {
    await ElMessageBox.confirm(`删除“${rule.name}”？历史触发记录会保留。`, '删除规则', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
    });
    await write(`/alert-rules/${rule.id}`, 'DELETE');
    await client.invalidateQueries({ queryKey: ['rules'] });
    ElMessage.success('规则已删除');
  } catch (err) {
    if (err instanceof Error) ElMessage.error(err.message);
  }
}
async function test(rule: AlertRule) {
  testTitle.value = rule.name;
  testResult.value = null;
  testOpen.value = true;
  try {
    testResult.value = (
      await write<Record<string, unknown>>('/alert-rules/test', 'POST', { ruleId: rule.id })
    ).data;
  } catch (err) {
    testResult.value = { error: err instanceof Error ? err.message : '测试失败' };
  }
}
</script>
<template>
  <div class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">ALERT ENGINE</div>
        <h1>预警规则<span class="title-dot">.</span></h1>
        <p>定义你关注的变化，以可解释的条件筛选信号。</p>
      </div>
      <button class="btn btn-primary" @click="edit()">
        <RadarIcon name="plus" :size="16" />新建规则
      </button>
    </div>
    <div class="summary-strip">
      <span
        ><b>{{ number(data?.data.length) }}</b> 条规则</span
      ><span
        ><span class="status-dot" /><b>{{ activeCount }}</b> 条已启用</span
      ><span>结构化条件 · 无脚本执行 · 每次修改保留版本</span>
    </div>
    <DataState
      :loading="isPending"
      :error="error"
      :empty="data?.data.length === 0"
      empty-text="创建第一条预警规则"
      @retry="refetch()"
      ><div class="rule-list">
        <section v-for="rule in data?.data" :key="rule.id" class="panel rule-card">
          <div class="rule-card-top">
            <span class="rule-icon"><RadarIcon name="rules" :size="21" /></span>
            <div>
              <h2>
                {{ rule.name
                }}<span :class="`priority priority-${rule.priority.toLowerCase()}`">{{
                  rule.priority
                }}</span>
              </h2>
              <p>
                v{{ rule.version }} · 更新于 {{ date(rule.updatedAt) }} · 冷却
                {{ number(rule.cooldownSeconds / 60) }} 分钟
              </p>
            </div>
            <el-switch
              :model-value="rule.enabled"
              :aria-label="`${rule.name}启用状态`"
              @change="toggle(rule)"
            />
          </div>
          <div class="rule-conditions">
            <span v-if="rule.conditions.minConfidence !== undefined"
              >置信度 ≥ <b>{{ Math.round(rule.conditions.minConfidence * 100) }}%</b></span
            ><span v-if="rule.conditions.minOpportunityScore !== undefined"
              >机会评分 ≥ <b>{{ rule.conditions.minOpportunityScore }}</b></span
            ><span v-if="rule.conditions.maxRiskScore !== undefined"
              >风险评分 ≤ <b>{{ rule.conditions.maxRiskScore }}</b></span
            ><span v-if="rule.conditions.verifiedOnly"
              ><RadarIcon name="shield" :size="13" />仅已验证来源</span
            ><span v-if="rule.conditions.assets?.length"
              >资产：<b>{{ rule.conditions.assets.join(' / ') }}</b></span
            ><span v-if="rule.conditions.sourceIds?.length"
              >来源：<b>{{ rule.conditions.sourceIds.join(' / ') }}</b></span
            ><span v-if="rule.conditions.eventTypes?.length">{{
              rule.conditions.eventTypes.join(' / ')
            }}</span
            ><span
              >推送渠道 <b>{{ rule.channelIds.length }}</b> 个</span
            >
          </div>
          <div class="rule-card-bottom">
            <span class="muted text-xs">{{
              rule.enabled
                ? '规则持续检测，匹配后按冷却与偏好推送。'
                : '规则已暂停，不再产生新的通知。'
            }}</span>
            <div>
              <button class="text-link" @click="test(rule)">
                <RadarIcon name="code" :size="14" />测试规则</button
              ><button class="icon-btn" :aria-label="`编辑${rule.name}`" @click="edit(rule)">
                <RadarIcon name="edit" :size="16" /></button
              ><button
                class="icon-btn danger-hover"
                :aria-label="`删除${rule.name}`"
                @click="remove(rule)"
              >
                <RadarIcon name="trash" :size="16" />
              </button>
            </div>
          </div>
        </section></div
    ></DataState>
    <section class="panel section-block">
      <div class="panel-heading">
        <div>
          <span class="section-number">02</span>
          <h2>规则触发历史</h2>
        </div>
        <button class="text-link" @click="refreshTriggers()">
          <RadarIcon name="refresh" :size="13" />刷新
        </button>
      </div>
      <DataState
        :error="triggersError"
        :empty="triggers?.data.length === 0"
        empty-text="尚无规则触发记录"
        @retry="refreshTriggers()"
      >
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>触发时间</th>
                <th>规则 / 版本</th>
                <th>级别</th>
                <th>命中原因</th>
                <th>事件</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="trigger in triggers?.data" :key="trigger.id">
                <td>{{ date(trigger.detectedAt) }}</td>
                <td>
                  {{ data?.data.find((rule) => rule.id === trigger.ruleId)?.name ?? '历史规则' }} /
                  v{{ trigger.ruleVersion }}
                </td>
                <td>
                  <span class="priority" :class="`priority-${trigger.priority?.toLowerCase()}`">{{
                    trigger.priority ?? '—'
                  }}</span>
                </td>
                <td>
                  {{
                    Array.isArray(trigger.reason)
                      ? trigger.reason.join('；')
                      : typeof trigger.reason === 'string'
                        ? trigger.reason
                        : JSON.stringify(trigger.reason)
                  }}
                </td>
                <td>
                  <RouterLink
                    v-if="trigger.eventId"
                    :to="`/events/${trigger.eventId}`"
                    class="text-link"
                    >查看事件<RadarIcon name="arrow" :size="12" /></RouterLink
                  ><span v-else>—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </DataState>
    </section>
    <el-dialog
      v-model="dialog"
      :title="editingId ? '编辑预警规则' : '新建预警规则'"
      width="640px"
      align-center
      ><form class="form-grid" @submit.prevent="save">
        <div class="form-field full">
          <label for="rule-name">规则名称</label
          ><input
            id="rule-name"
            v-model="form.name"
            required
            maxlength="100"
            placeholder="例如：可信的新协议早期参与"
          />
        </div>
        <div class="form-field">
          <label for="rule-priority">通知优先级</label
          ><select id="rule-priority" v-model="form.priority">
            <option v-for="value in ['P0', 'P1', 'P2', 'P3']" :key="value">{{ value }}</option>
          </select>
        </div>
        <div class="form-field">
          <label for="rule-cooldown">冷却时间（秒）</label
          ><input
            id="rule-cooldown"
            v-model="form.cooldownSeconds"
            type="number"
            min="60"
            max="604800"
            required
          />
        </div>
        <div class="form-field">
          <label for="rule-confidence">最低置信度（%）</label
          ><input
            id="rule-confidence"
            v-model="form.minConfidence"
            type="number"
            min="0"
            max="100"
            required
          />
        </div>
        <div class="form-field">
          <label for="rule-opportunity">最低机会评分</label
          ><input
            id="rule-opportunity"
            v-model="form.minOpportunityScore"
            type="number"
            min="0"
            max="100"
            required
          />
        </div>
        <div class="form-field">
          <label for="rule-risk">最高风险评分</label
          ><input
            id="rule-risk"
            v-model="form.maxRiskScore"
            type="number"
            min="0"
            max="100"
            required
          />
        </div>
        <div class="form-field">
          <label for="rule-growth">最低参与增长（%，0 不限制）</label
          ><input
            id="rule-growth"
            v-model="form.minParticipantGrowthPct"
            type="number"
            min="0"
            max="1000000"
            required
          />
        </div>
        <div class="form-field">
          <label for="rule-mint-start">最低铸造进度（%，0 不限制）</label
          ><input
            id="rule-mint-start"
            v-model="form.minMintProgress"
            type="number"
            min="0"
            max="100"
            required
          />
        </div>
        <div class="form-field">
          <label for="rule-mint-end">最高铸造进度（%，100 不限制）</label
          ><input
            id="rule-mint-end"
            v-model="form.maxMintProgress"
            type="number"
            min="0"
            max="100"
            required
          />
        </div>
        <div class="form-field">
          <label for="rule-assets">资产（逗号分隔，可空）</label
          ><input id="rule-assets" v-model="form.assets" placeholder="BTC, ETH" maxlength="500" />
        </div>
        <div class="form-field">
          <label for="rule-window">检测窗口（秒）</label
          ><input
            id="rule-window"
            v-model="form.windowSeconds"
            type="number"
            min="60"
            max="604800"
            required
          />
        </div>
        <div class="form-field">
          <label for="rule-price">最低价格变化（%，0 不限制）</label
          ><input
            id="rule-price"
            v-model="form.minPriceChangePct"
            type="number"
            min="0"
            max="1000000"
          />
        </div>
        <div class="form-field">
          <label for="rule-yield">最低收益率变化（bps，0 不限制）</label
          ><input
            id="rule-yield"
            v-model="form.minYieldChangeBps"
            type="number"
            min="0"
            max="1000000"
          />
        </div>
        <div class="form-field">
          <label for="rule-chains">公链（逗号分隔，可空）</label
          ><input
            id="rule-chains"
            v-model="form.chains"
            placeholder="bitcoin, ethereum"
            maxlength="1000"
          />
        </div>
        <div class="form-field">
          <label for="rule-stages">阶段（逗号分隔，可空）</label
          ><input
            id="rule-stages"
            v-model="form.stages"
            placeholder="EARLY_STAGE, ACTIVE"
            maxlength="1000"
          />
        </div>
        <div class="form-field full">
          <label for="rule-source-ids">新项目来源 ID（逗号分隔，可空）</label
          ><input
            id="rule-source-ids"
            v-model="form.sourceIds"
            placeholder="例如 chain-fixture, github-releases"
            maxlength="3000"
          /><span class="muted text-xs">使用数据源页面显示的 ID；留空匹配全部来源。</span>
        </div>
        <div class="form-field full">
          <label for="rule-categories">监控分类（逗号分隔，可空）</label
          ><input
            id="rule-categories"
            v-model="form.categories"
            placeholder="macro, finance, technology, world, crypto"
            maxlength="1000"
          />
        </div>
        <div class="form-field full">
          <label for="rule-types">事件类型（逗号分隔，可空）</label
          ><input
            id="rule-types"
            v-model="form.eventTypes"
            placeholder="NEW_PROTOCOL, MINT_STARTED"
            maxlength="1000"
          />
        </div>
        <div class="form-field full">
          <label>推送渠道</label>
          <div class="checkbox-list">
            <label v-for="channel in channels?.data" :key="channel.id"
              ><input v-model="form.channelIds" type="checkbox" :value="channel.id" />{{
                channel.name
              }}
              <span class="muted">{{ channel.configured ? '' : '（未配置）' }}</span></label
            ><span v-if="!channels?.data.length" class="muted">暂无渠道，可先保存规则。</span>
          </div>
        </div>
        <div class="form-field full">
          <label class="checkbox-label"
            ><input v-model="form.verifiedOnly" type="checkbox" />只匹配已验证来源</label
          >
        </div>
        <div v-if="formError" class="form-error full" role="alert">{{ formError }}</div>
        <div class="dialog-actions full">
          <button type="button" class="btn" @click="dialog = false">取消</button
          ><button class="btn btn-primary" type="submit" :disabled="busy">
            {{ busy ? '保存中…' : '保存规则' }}
          </button>
        </div>
      </form></el-dialog
    ><el-dialog v-model="testOpen" title="规则测试" width="600px" align-center
      ><p class="muted">{{ testTitle }} · 测试只评估已有事件，不会实际发送通知。</p>
      <pre v-if="testResult" class="json-view">{{ JSON.stringify(testResult, null, 2) }}</pre>
      <div v-else class="empty-inline">正在评估…</div></el-dialog
    >
  </div>
</template>
