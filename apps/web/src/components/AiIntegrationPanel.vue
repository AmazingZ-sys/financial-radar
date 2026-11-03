<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { AIConfigViewSchema, AIConnectionTestSchema } from '@radar/shared';
import { ElMessage } from 'element-plus';
import { api, ApiError, write } from '../lib/api';
import DataState from './DataState.vue';
import RadarIcon from './RadarIcon.vue';

const client = useQueryClient();
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['ai-integration'],
  queryFn: () => api('/integrations/ai', {}, AIConfigViewSchema),
});
const form = reactive({
  name: '',
  enabled: false,
  baseUrl: '',
  model: '',
  timeoutMs: 20000,
  jsonMode: true,
  dailyBudgetUsd: 1,
  maxCallCostUsd: 0.1,
});
const apiKey = ref('');
const clearApiKey = ref(false);
const saving = ref(false);
const testing = ref(false);
const saveError = ref('');
const testMessage = ref('');
const testFailed = ref(false);
const recoveryError = ref('');
const keyUnavailable = computed(
  () => error.value instanceof ApiError && error.value.code === 'INTEGRATION_KEY_ERROR',
);
const saved = ref('');
const dirty = computed(
  () => JSON.stringify(form) !== saved.value || !!apiKey.value || clearApiKey.value,
);
watch(
  data,
  (value) => {
    if (!value || (saved.value && dirty.value)) return;
    const v = value.data;
    Object.assign(form, {
      name: v.name,
      enabled: v.enabled,
      baseUrl: v.baseUrl,
      model: v.model,
      timeoutMs: v.timeoutMs,
      jsonMode: v.jsonMode,
      dailyBudgetUsd: v.dailyBudgetUsd,
      maxCallCostUsd: v.maxCallCostUsd,
    });
    saved.value = JSON.stringify(form);
  },
  { immediate: true },
);
watch(clearApiKey, (value) => {
  if (value) apiKey.value = '';
});
onBeforeUnmount(() => {
  apiKey.value = '';
});
async function save() {
  saving.value = true;
  saveError.value = '';
  testMessage.value = '';
  const submitted = { ...form };
  try {
    await write('/integrations/ai', 'PATCH', {
      ...submitted,
      ...(apiKey.value ? { apiKey: apiKey.value } : {}),
      ...(clearApiKey.value ? { clearApiKey: true } : {}),
    });
    apiKey.value = '';
    clearApiKey.value = false;
    saved.value = JSON.stringify(submitted);
    await client.invalidateQueries({ queryKey: ['ai-integration'] });
    await client.invalidateQueries({ queryKey: ['system-status'] });
    ElMessage.success('AI 配置已保存，后续分析使用新配置');
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    apiKey.value = '';
    saving.value = false;
  }
}
async function test() {
  testing.value = true;
  testMessage.value = '';
  testFailed.value = false;
  try {
    const result = await api(
      '/integrations/ai/test',
      {
        method: 'POST',
        signal: AbortSignal.timeout(70000),
      },
      AIConnectionTestSchema,
    );
    testMessage.value = result.data.message;
  } catch (err) {
    testFailed.value = true;
    testMessage.value = err instanceof Error ? err.message : '连接测试失败';
  } finally {
    testing.value = false;
  }
}
async function clearUnavailableKey() {
  saving.value = true;
  recoveryError.value = '';
  try {
    await write('/integrations/ai', 'PATCH', { clearApiKey: true });
    await client.invalidateQueries({ queryKey: ['ai-integration'] });
    await client.invalidateQueries({ queryKey: ['system-status'] });
    ElMessage.success('失效的 API Key 已清除，请重新填写凭据');
  } catch (err) {
    recoveryError.value = err instanceof Error ? err.message : '清除失败';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="panel detail-panel integration-panel" aria-labelledby="ai-config-heading">
    <div class="panel-heading">
      <div>
        <span class="integration-mark">AI</span>
        <h2 id="ai-config-heading">AI Provider 配置</h2>
      </div>
      <span
        v-if="data"
        class="badge"
        :class="data.data.apiKeyConfigured && !!data.data.model ? 'badge-healthy' : 'badge-unknown'"
      >
        {{ data.data.apiKeyConfigured && !!data.data.model ? '凭据已配置' : '待配置' }}
      </span>
    </div>
    <DataState :loading="isPending" :error="error" @retry="refetch()">
      <template v-if="data">
        <div class="integration-context">
          <span class="badge">{{
            data.data.configOrigin === 'database' ? '控制台配置' : '环境变量默认值'
          }}</span>
          <p>连接官方服务或兼容 Chat Completions 的中转站。保存后对后续任务生效。</p>
        </div>
        <form class="form-grid integration-form" autocomplete="off" @submit.prevent="save">
          <div class="form-field">
            <label for="ai-name">Provider 名称</label>
            <input
              id="ai-name"
              v-model="form.name"
              required
              maxlength="100"
              placeholder="我的 AI 中转站"
            />
          </div>
          <div class="form-field">
            <label for="ai-enabled">AI 分析</label>
            <select id="ai-enabled" v-model="form.enabled">
              <option :value="true">启用</option>
              <option :value="false">停用</option>
            </select>
          </div>
          <div class="form-field full">
            <label for="ai-base-url">API Base URL</label>
            <input
              id="ai-base-url"
              v-model="form.baseUrl"
              type="url"
              required
              placeholder="https://relay.example.com/v1"
            />
            <span class="field-hint"
              >填写 HTTPS API 根路径（通常包含 /v1），系统追加 /chat/completions。</span
            >
          </div>
          <div class="form-field">
            <label for="ai-model">模型名称</label>
            <input
              id="ai-model"
              v-model="form.model"
              maxlength="150"
              placeholder="服务商提供的模型 ID"
            />
          </div>
          <div class="form-field">
            <label for="ai-api-key">API Key</label>
            <input
              id="ai-api-key"
              v-model="apiKey"
              type="password"
              autocomplete="new-password"
              :disabled="clearApiKey"
              :placeholder="data.data.apiKeyConfigured ? '已配置 · 留空保留' : '输入服务商 API Key'"
            />
            <label class="integration-checkbox"
              ><input v-model="clearApiKey" type="checkbox" />清除已保存的 API Key</label
            >
          </div>
          <div class="form-field">
            <label for="ai-timeout">请求超时（毫秒）</label>
            <input
              id="ai-timeout"
              v-model.number="form.timeoutMs"
              type="number"
              min="1000"
              max="60000"
              step="1000"
              required
            />
          </div>
          <div class="form-field">
            <label for="ai-json-mode">JSON 输出模式</label>
            <select id="ai-json-mode" v-model="form.jsonMode">
              <option :value="true">启用 response_format</option>
              <option :value="false">仅使用提示词约束</option>
            </select>
            <span class="field-hint"
              >中转站不支持 JSON 模式时可关闭，结果仍需通过结构与证据校验。</span
            >
          </div>
          <div class="form-field">
            <label for="ai-daily-budget">每日预算（USD）</label>
            <input
              id="ai-daily-budget"
              v-model.number="form.dailyBudgetUsd"
              type="number"
              min="0"
              max="10000"
              step="0.01"
              required
            />
          </div>
          <div class="form-field">
            <label for="ai-call-cost">单次保守预留（USD）</label>
            <input
              id="ai-call-cost"
              v-model.number="form.maxCallCostUsd"
              type="number"
              min="0"
              max="1000"
              step="0.001"
              required
            />
          </div>
          <p v-if="saveError" class="form-error full" role="alert">{{ saveError }}</p>
          <p
            v-if="testMessage"
            class="integration-result full"
            :class="{ 'text-danger': testFailed }"
            role="status"
          >
            {{ testMessage }}
          </p>
          <div class="integration-actions full">
            <span class="field-hint">{{
              dirty
                ? '有未保存的修改，请先保存再测试'
                : '仅测试已保存的配置；真实模式下可能产生调用费用'
            }}</span>
            <div>
              <button
                class="btn"
                type="button"
                :disabled="
                  saving ||
                  testing ||
                  dirty ||
                  !(data.data.apiKeyConfigured && !!data.data.model) ||
                  !data.data.enabled
                "
                @click="test"
              >
                <RadarIcon name="refresh" :size="14" />{{ testing ? '测试中…' : '测试 AI 连接' }}
              </button>
              <button class="btn btn-primary" type="submit" :disabled="saving || testing">
                {{ saving ? '保存中…' : '保存 AI 配置' }}
              </button>
            </div>
          </div>
        </form>
        <p class="integration-security">
          <RadarIcon name="shield" :size="14" />密钥仅提交到服务器加密保存，页面不回显。Fixture
          模式跳过真实调用；AI 不可用时规则告警继续运行。
        </p>
      </template>
    </DataState>
    <div v-if="keyUnavailable" class="integration-key-recovery">
      <p>
        服务器加密密钥已变更或当前不可用，无法读取原有 API
        Key。清除失效密钥会保留地址、模型等配置，随后可重新填写凭据。
      </p>
      <p v-if="recoveryError" class="form-error" role="alert">{{ recoveryError }}</p>
      <button class="btn" type="button" :disabled="saving" @click="clearUnavailableKey">
        {{ saving ? '清除中…' : '清除失效的 API Key' }}
      </button>
    </div>
  </section>
</template>
