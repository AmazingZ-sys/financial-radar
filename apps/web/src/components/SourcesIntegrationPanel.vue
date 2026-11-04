<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { SourceIntegrationsSchema, type SourceIntegrations } from '@radar/shared';
import { ElMessage } from 'element-plus';
import { api, write } from '../lib/api';
import DataState from './DataState.vue';
import RadarIcon from './RadarIcon.vue';

const client = useQueryClient();
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['source-integrations'],
  queryFn: () => api('/integrations/sources', {}, SourceIntegrationsSchema),
});
const open = ref(false);
const saving = ref(false);
const saveError = ref('');
const form = reactive({
  unisatApiKey: '',
  evmRpcUrl: '',
  solanaRpcUrl: '',
  evmFactoryAddress: '',
  solanaProgramId: '',
  dexChain: 'solana',
  tokenAddresses: '',
  clearUnisatApiKey: false,
  clearEvmRpcUrl: false,
  clearSolanaRpcUrl: false,
});
function clearDrafts() {
  Object.assign(form, {
    unisatApiKey: '',
    evmRpcUrl: '',
    solanaRpcUrl: '',
    clearUnisatApiKey: false,
    clearEvmRpcUrl: false,
    clearSolanaRpcUrl: false,
  });
}
function loadFields(value: SourceIntegrations) {
  Object.assign(form, {
    evmFactoryAddress: value.evmFactoryAddress,
    solanaProgramId: value.solanaProgramId,
    dexChain: value.dexChain,
    tokenAddresses: value.dexTokenAddresses.join('\n'),
  });
}
watch(
  data,
  (value) => {
    if (value && !open.value) loadFields(value.data);
  },
  { immediate: true },
);
watch(open, (value) => {
  clearDrafts();
  saveError.value = '';
  if (value && data.value) loadFields(data.value.data);
});
onBeforeUnmount(clearDrafts);
const connections = computed(() => {
  const value = data.value?.data;
  if (!value) return [];
  return [
    {
      name: 'UniSat',
      detail: 'BRC-20 部署索引',
      configured: value.unisatApiKeyConfigured,
      url: value.links.unisat,
      action: '申请 API Key',
    },
    {
      name: 'Ethereum RPC',
      detail: '主网 · 指定 V2 Factory',
      configured: value.evmRpcConfigured && !!value.evmFactoryAddress,
      url: value.links.ethereumRpc,
      action: '创建 RPC 端点',
    },
    {
      name: 'Solana RPC',
      detail: '主网 · 指定 Program',
      configured: value.solanaRpcConfigured && !!value.solanaProgramId,
      url: value.links.solanaRpc,
      action: '创建 RPC 端点',
    },
    {
      name: 'DEX Screener',
      detail: '已知 token 观察列表 · 无需 Key',
      configured: value.dexTokenAddresses.length > 0,
      url: value.links.dex,
      action: '查看接口说明',
    },
  ];
});
async function save() {
  saving.value = true;
  saveError.value = '';
  try {
    await write('/integrations/sources', 'PATCH', {
      evmFactoryAddress: form.evmFactoryAddress.trim(),
      solanaProgramId: form.solanaProgramId.trim(),
      dexChain: form.dexChain,
      dexTokenAddresses: form.tokenAddresses.split(/[\s,;]+/).filter(Boolean),
      ...(form.unisatApiKey ? { unisatApiKey: form.unisatApiKey } : {}),
      ...(form.evmRpcUrl ? { evmRpcUrl: form.evmRpcUrl } : {}),
      ...(form.solanaRpcUrl ? { solanaRpcUrl: form.solanaRpcUrl } : {}),
      ...(form.clearUnisatApiKey ? { clearUnisatApiKey: true } : {}),
      ...(form.clearEvmRpcUrl ? { clearEvmRpcUrl: true } : {}),
      ...(form.clearSolanaRpcUrl ? { clearSolanaRpcUrl: true } : {}),
    });
    open.value = false;
    await Promise.all(
      ['source-integrations', 'sources', 'source-catalog', 'system-status'].map((key) =>
        client.invalidateQueries({ queryKey: [key] }),
      ),
    );
    ElMessage.success('数据源配置已保存，Worker 将在后续采集中使用');
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    clearDrafts();
    saving.value = false;
  }
}
</script>

<template>
  <section
    id="source-connections"
    class="panel detail-panel source-connections"
    aria-labelledby="source-connections-heading"
  >
    <div class="panel-heading">
      <div>
        <span class="section-number">01</span>
        <h2 id="source-connections-heading">数据源接入设置</h2>
      </div>
      <button
        class="btn"
        :aria-expanded="open"
        aria-controls="source-connection-form"
        :disabled="saving || !data"
        @click="open = !open"
      >
        {{ open ? '收起设置' : '编辑连接设置' }}
      </button>
    </div>
    <p class="muted">申请凭据、填写监控范围并保存。凭据是否有效，以后续采集健康记录为准。</p>
    <DataState :loading="isPending" :error="error" @retry="refetch()">
      <template v-if="data">
        <div class="connection-overview">
          <article v-for="connection in connections" :key="connection.name">
            <div>
              <h3>{{ connection.name }}</h3>
              <span
                class="badge"
                :class="connection.configured ? 'badge-healthy' : 'badge-unknown'"
                >{{ connection.configured ? '已配置' : '待配置' }}</span
              >
            </div>
            <p>{{ connection.detail }}</p>
            <a class="text-link" :href="connection.url" target="_blank" rel="noopener noreferrer"
              >{{ connection.action }}<RadarIcon name="external" :size="12"
            /></a>
          </article>
        </div>
        <p v-if="data.data.credentialError" class="form-error" role="alert">
          部分凭据无法解密，请重新填写或显式清除后保存。
        </p>
        <form
          v-if="open"
          id="source-connection-form"
          class="form-grid integration-form"
          autocomplete="off"
          @submit.prevent="save"
        >
          <p class="full field-hint">
            {{
              data.data.configOrigin === 'database'
                ? '当前使用控制台配置。'
                : '当前使用服务器环境默认配置。'
            }}
            密钥和 RPC 地址留空保留；勾选清除后不再使用环境默认凭据。
          </p>
          <fieldset class="integration-fieldset full">
            <legend>UniSat</legend>
            <div class="form-field">
              <label for="source-unisat-key">UniSat API Key</label
              ><input
                id="source-unisat-key"
                v-model="form.unisatApiKey"
                type="password"
                autocomplete="new-password"
                :disabled="form.clearUnisatApiKey"
                :placeholder="
                  data.data.unisatApiKeyConfigured
                    ? '已配置 · 留空保留'
                    : '从 UniSat 开发者中心复制 Key'
                "
              /><label class="integration-checkbox"
                ><input v-model="form.clearUnisatApiKey" type="checkbox" />清除 UniSat Key</label
              >
            </div>
          </fieldset>
          <fieldset class="integration-fieldset full connection-fields">
            <legend>Ethereum 主网 RPC</legend>
            <div class="form-field">
              <label for="source-evm-rpc">Ethereum RPC URL</label
              ><input
                id="source-evm-rpc"
                v-model="form.evmRpcUrl"
                type="password"
                autocomplete="new-password"
                :disabled="form.clearEvmRpcUrl"
                :placeholder="
                  data.data.evmRpcConfigured
                    ? '已配置 · 留空保留'
                    : 'https://eth-mainnet.g.alchemy.com/v2/…'
                "
              /><label class="integration-checkbox"
                ><input v-model="form.clearEvmRpcUrl" type="checkbox" />清除 Ethereum RPC</label
              >
            </div>
            <div class="form-field">
              <label for="source-evm-factory">V2 Factory 合约地址</label
              ><input
                id="source-evm-factory"
                v-model="form.evmFactoryAddress"
                placeholder="0x…（已核验的 Ethereum 主网 V2 Factory）"
              /><span class="field-hint"
                >需要 RPC 与 Factory 两项；只监控该 Factory 的 finalized PairCreated 事件。</span
              >
            </div>
          </fieldset>
          <fieldset class="integration-fieldset full connection-fields">
            <legend>Solana 主网 RPC</legend>
            <div class="form-field">
              <label for="source-solana-rpc">Solana RPC URL</label
              ><input
                id="source-solana-rpc"
                v-model="form.solanaRpcUrl"
                type="password"
                autocomplete="new-password"
                :disabled="form.clearSolanaRpcUrl"
                :placeholder="
                  data.data.solanaRpcConfigured
                    ? '已配置 · 留空保留'
                    : 'https://mainnet.helius-rpc.com/?api-key=…'
                "
              /><label class="integration-checkbox"
                ><input v-model="form.clearSolanaRpcUrl" type="checkbox" />清除 Solana RPC</label
              >
            </div>
            <div class="form-field">
              <label for="source-solana-program">Solana Program ID</label
              ><input
                id="source-solana-program"
                v-model="form.solanaProgramId"
                placeholder="已核验的主网 Program 地址"
              /><span class="field-hint"
                >只监控指定 Program 的 finalized 交易内新 Mint；不会扫描全链。</span
              >
            </div>
          </fieldset>
          <fieldset class="integration-fieldset full connection-fields">
            <legend>DEX Screener 观察范围</legend>
            <div class="form-field">
              <label for="source-dex-chain">DEX 观察链</label
              ><select id="source-dex-chain" v-model="form.dexChain">
                <option
                  v-for="chain in [
                    'solana',
                    'ethereum',
                    'base',
                    'arbitrum',
                    'optimism',
                    'polygon',
                    'bsc',
                  ]"
                  :key="chain"
                  :value="chain"
                >
                  {{ chain }}
                </option></select
              ><span class="field-hint">当前公开 token 接口无需 API Key。</span>
            </div>
            <div class="form-field">
              <label for="source-dex-tokens">DEX Token 地址</label
              ><textarea
                id="source-dex-tokens"
                v-model="form.tokenAddresses"
                rows="4"
                placeholder="最多30个同链 token，以换行或逗号分隔"
              /><span class="field-hint">只跟踪已知 token 的池与流动性，空列表停用采集。</span>
            </div>
          </fieldset>
          <p v-if="saveError" class="form-error full" role="alert">{{ saveError }}</p>
          <div class="integration-actions full">
            <span class="field-hint"
              >保存后约15秒内同步；Fixture
              模式仍不会采集真实数据。范围变更后会重新建立采集检查点。</span
            >
            <div>
              <button type="button" class="btn" :disabled="saving" @click="open = false">
                取消</button
              ><button class="btn btn-primary" type="submit" :disabled="saving">
                {{ saving ? '保存中…' : '保存数据源配置' }}
              </button>
            </div>
          </div>
        </form>
      </template>
    </DataState>
  </section>
</template>

<style scoped>
.source-connections {
  margin-bottom: 24px;
}
.source-connections .form-field > input:not([type='checkbox']) {
  width: 100%;
  height: auto;
}
.connection-overview {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
  margin-top: 20px;
}
.connection-overview article {
  min-width: 0;
  padding: 15px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.connection-overview article > div {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.connection-overview h3 {
  font-size: 13px;
  margin: 0;
}
.connection-overview p {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.8;
  margin: 10px 0;
}
.connection-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}
.connection-fields > div {
  min-width: 0;
}
@media (max-width: 700px) {
  .connection-fields {
    grid-template-columns: 1fr;
  }
  .panel-heading {
    flex-wrap: wrap;
    gap: 12px;
  }
}
</style>
