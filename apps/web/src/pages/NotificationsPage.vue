<script setup lang="ts">
import { onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { z } from 'zod';
import {
  NotificationConfigPatchSchema,
  NotificationConfigViewSchema,
  NotificationSchema,
} from '@radar/shared';
import { ElMessage } from 'element-plus';
import { api, write } from '../lib/api';
import { date, number } from '../lib/format';
import DataState from '../components/DataState.vue';
import RadarIcon from '../components/RadarIcon.vue';
import StatusBadge from '../components/StatusBadge.vue';
const client = useQueryClient();
const testBusy = ref('');
const smtpGuides = [
  {
    label: 'Gmail SMTP 官方说明',
    href: 'https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app',
  },
  {
    label: '创建应用专用密码',
    href: 'https://myaccount.google.com/apppasswords',
  },
  {
    label: '开启两步验证',
    href: 'https://myaccount.google.com/signinoptions/two-step-verification/enroll-welcome',
  },
] as const;
type ChannelConfig = z.infer<typeof NotificationConfigViewSchema>;
const selected = ref<ChannelConfig | null>(null);
const configOpen = ref(false);
const configBusy = ref(false);
const configError = ref('');
const form = reactive({
  name: '',
  enabled: true,
  botToken: '',
  chatId: '',
  webhookUrl: '',
  serverUrl: '',
  smtpHost: '',
  smtpPort: 587,
  smtpSecurity: 'starttls' as 'tls' | 'starttls',
  smtpUsername: '',
  smtpPassword: '',
  fromEmail: '',
  toEmails: '',
  clearCredentials: false,
});
function clearSecrets() {
  form.botToken = '';
  form.webhookUrl = '';
  form.serverUrl = '';
  form.smtpPassword = '';
}
watch(configOpen, (open) => {
  if (!open) clearSecrets();
});
watch(
  () => form.clearCredentials,
  (clear) => {
    if (clear) {
      clearSecrets();
      form.chatId = '';
    }
  },
);
onBeforeUnmount(clearSecrets);
const {
  data: channels,
  isPending,
  error,
  refetch,
} = useQuery({
  queryKey: ['channels'],
  queryFn: () => api('/notification-channels', {}, z.array(NotificationConfigViewSchema)),
});
const {
  data: notifications,
  isPending: notificationsPending,
  error: notificationsError,
  refetch: refreshNotifications,
} = useQuery({
  queryKey: ['notifications'],
  queryFn: () => api('/notifications?pageSize=50', {}, z.array(NotificationSchema)),
});
async function toggle(channel: ChannelConfig) {
  try {
    await write(`/notification-channels/${channel.id}`, 'PATCH', { enabled: !channel.enabled });
    await client.invalidateQueries({ queryKey: ['channels'] });
    ElMessage.success('渠道状态已更新');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败');
  }
}
function configure(channel: ChannelConfig) {
  selected.value = channel;
  clearSecrets();
  Object.assign(form, {
    name: channel.name,
    enabled: channel.enabled,
    chatId: channel.chatId,
    smtpHost: channel.provider === 'email' ? channel.smtpHost : '',
    smtpPort: channel.provider === 'email' ? (channel.smtpPort ?? 587) : 587,
    smtpSecurity: channel.provider === 'email' ? (channel.smtpSecurity ?? 'starttls') : 'starttls',
    smtpUsername: channel.provider === 'email' ? channel.smtpUsername : '',
    fromEmail: channel.provider === 'email' ? channel.fromEmail : '',
    toEmails: channel.provider === 'email' ? channel.toEmails.join(', ') : '',
    clearCredentials: false,
  });
  configError.value = '';
  configOpen.value = true;
}
async function saveChannel() {
  if (!selected.value) return;
  configBusy.value = true;
  configError.value = '';
  try {
    const input = NotificationConfigPatchSchema.safeParse({
      name: form.name,
      enabled: form.enabled,
      ...(form.clearCredentials
        ? { clearCredentials: true }
        : selected.value.provider === 'telegram'
          ? { chatId: form.chatId, ...(form.botToken ? { botToken: form.botToken } : {}) }
          : selected.value.provider === 'feishu'
            ? form.webhookUrl
              ? { webhookUrl: form.webhookUrl }
              : {}
            : selected.value.provider === 'bark'
              ? form.serverUrl
                ? { serverUrl: form.serverUrl }
                : {}
              : {
                  smtpHost: form.smtpHost,
                  smtpPort: form.smtpPort,
                  smtpSecurity: form.smtpSecurity,
                  smtpUsername: form.smtpUsername,
                  fromEmail: form.fromEmail,
                  toEmails: form.toEmails
                    .split(/[\n,;]+/)
                    .map((email) => email.trim())
                    .filter(Boolean),
                  ...(form.smtpPassword ? { smtpPassword: form.smtpPassword } : {}),
                }),
    });
    if (!input.success)
      throw new Error(input.error.issues.map((issue) => issue.message).join('；'));
    await write(`/notification-channels/${selected.value.id}`, 'PATCH', input.data);
    configOpen.value = false;
    await client.invalidateQueries({ queryKey: ['channels'] });
    await client.invalidateQueries({ queryKey: ['system-status'] });
    ElMessage.success('通知渠道配置已保存，后续发送使用新配置');
  } catch (err) {
    configError.value = err instanceof Error ? err.message : '保存失败';
  } finally {
    clearSecrets();
    configBusy.value = false;
  }
}
async function test(channel: ChannelConfig) {
  testBusy.value = channel.id;
  try {
    await write('/notification-channels/test', 'POST', { channelId: channel.id });
    await client.invalidateQueries({ queryKey: ['notifications'] });
    ElMessage.success('测试请求已入队，请在记录中查看结果。平台接受不代表用户已读。');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '测试失败');
  } finally {
    testBusy.value = '';
  }
}
async function retry(id: string) {
  try {
    await write(`/notifications/${id}/retry`, 'POST');
    await client.invalidateQueries({ queryKey: ['notifications'] });
    ElMessage.success('已请求重试');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败');
  }
}
</script>
<template>
  <div class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">DELIVERY CENTER</div>
        <h1>通知中心<span class="title-dot">.</span></h1>
        <p>把重要变化送达你选择的渠道，保留每一次发送与重试。</p>
      </div>
      <button class="btn" @click="refreshNotifications()">
        <RadarIcon name="refresh" :size="15" />刷新记录
      </button>
    </div>
    <div class="section-heading">
      <div>
        <span class="section-number">01</span>
        <h2>推送渠道</h2>
        <span class="section-subtitle">凭据加密保存，即时生效</span>
      </div>
      <RouterLink to="/system" class="text-link"
        >通知偏好<RadarIcon name="arrow" :size="14"
      /></RouterLink>
    </div>
    <DataState
      :loading="isPending"
      :error="error"
      :empty="channels?.data.length === 0"
      @retry="refetch()"
      ><div class="channel-grid">
        <section v-for="channel in channels?.data" :key="channel.id" class="panel channel-card">
          <div class="channel-heading">
            <span class="channel-icon" :class="channel.provider"
              ><RadarIcon
                :name="
                  channel.provider === 'telegram'
                    ? 'arrowUp'
                    : channel.provider === 'email'
                      ? 'mail'
                      : 'bell'
                "
                :size="24"
            /></span>
            <div>
              <h2>{{ channel.name }}</h2>
              <span>{{ channel.provider }}</span>
            </div>
            <el-switch
              :model-value="channel.enabled"
              :aria-label="`${channel.name}渠道启用状态`"
              @change="toggle(channel)"
            />
          </div>
          <p>
            {{ channel.description || '通知接口由服务端统一管理。' }}<br />{{
              channel.configOrigin === 'database' ? '使用控制台配置' : '使用环境变量默认值'
            }}
          </p>
          <div v-if="channel.provider === 'email'" class="smtp-card-links">
            <a
              v-for="guide in smtpGuides.slice(0, 2)"
              :key="guide.href"
              class="text-link"
              :href="guide.href"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ guide.label }}<RadarIcon name="external" :size="12" />
            </a>
          </div>
          <div class="channel-foot">
            <span class="badge" :class="channel.configured ? 'badge-healthy' : 'badge-unknown'"
              ><span class="status-dot" :class="{ offline: !channel.configured }" />{{
                channel.configured ? '凭据已配置' : '未配置凭据'
              }}</span
            >
            <div class="channel-actions">
              <button class="text-link" @click="configure(channel)">
                配置渠道<RadarIcon name="settings" :size="13" /></button
              ><button
                class="text-link"
                :disabled="!channel.configured || !channel.enabled || testBusy === channel.id"
                @click="test(channel)"
              >
                {{ testBusy === channel.id ? '提交中…' : '发送测试'
                }}<RadarIcon name="arrow" :size="14" />
              </button>
            </div>
          </div>
        </section></div
    ></DataState>
    <div class="notice-box">
      <RadarIcon name="shield" :size="17" />
      <p>
        “平台已接受”表示渠道 API
        确认接收请求，不代表用户已经收到或阅读。渠道凭据加密存放于服务器，保存后对后续发送生效；Fixture
        模式不向真实渠道发送。
      </p>
    </div>
    <el-dialog
      v-model="configOpen"
      :title="`配置 ${selected?.name ?? '通知渠道'}`"
      width="620px"
      align-center
      append-to-body
      :close-on-click-modal="false"
    >
      <form
        v-if="selected"
        class="form-grid integration-form"
        autocomplete="off"
        @submit.prevent="saveChannel"
      >
        <p class="muted full">
          {{ selected.provider }} ·
          {{
            selected.configOrigin === 'database' ? '控制台配置' : '环境变量默认值'
          }}。留空保留已有凭据。
        </p>
        <div class="form-field">
          <label for="channel-name">渠道名称</label
          ><input id="channel-name" v-model="form.name" maxlength="100" required />
        </div>
        <div class="form-field">
          <label for="channel-enabled">渠道状态</label
          ><select id="channel-enabled" v-model="form.enabled">
            <option :value="true">启用</option>
            <option :value="false">停用</option>
          </select>
        </div>
        <template v-if="selected.provider === 'telegram'">
          <div class="form-field full">
            <label for="channel-bot-token">Telegram Bot Token</label
            ><input
              id="channel-bot-token"
              v-model="form.botToken"
              type="password"
              autocomplete="new-password"
              :disabled="form.clearCredentials"
              :placeholder="selected.botTokenConfigured ? '已配置 · 留空保留' : '输入 Bot Token'"
            />
          </div>
          <div class="form-field full">
            <label for="channel-chat-id">Telegram Chat ID</label
            ><input
              id="channel-chat-id"
              v-model="form.chatId"
              maxlength="200"
              :disabled="form.clearCredentials"
              placeholder="用户、群组或频道的 Chat ID"
            />
          </div>
        </template>
        <div v-else-if="selected.provider === 'feishu'" class="form-field full">
          <label for="channel-webhook">飞书 Webhook URL</label
          ><input
            id="channel-webhook"
            v-model="form.webhookUrl"
            type="password"
            autocomplete="new-password"
            :disabled="form.clearCredentials"
            :placeholder="
              selected.webhookConfigured
                ? '已配置 · 留空保留'
                : 'https://open.feishu.cn/open-apis/bot/v2/hook/…'
            "
          /><span class="field-hint">填写机器人完整 HTTPS Webhook 地址。</span>
        </div>
        <div v-else-if="selected.provider === 'bark'" class="form-field full">
          <label for="channel-bark">Bark 推送地址</label
          ><input
            id="channel-bark"
            v-model="form.serverUrl"
            type="password"
            autocomplete="new-password"
            :disabled="form.clearCredentials"
            :placeholder="
              selected.webhookConfigured
                ? '已配置 · 留空保留'
                : 'https://bark.example.com/你的设备Key'
            "
          /><span class="field-hint">填写包含设备 Key 的完整 HTTPS 推送地址。</span>
        </div>
        <template v-else>
          <details class="smtp-guides full" aria-label="Gmail SMTP 设置入口">
            <summary>Gmail / Google Workspace 设置帮助</summary>
            <div class="smtp-guides-heading">
              <div>
                <p>
                  常用参数为 <code>smtp.gmail.com</code>、587 + STARTTLS。用户名使用完整邮箱地址；
                  应用专用密码需要先开启两步验证，不能填 Google 账号登录密码。
                </p>
              </div>
            </div>
            <div class="smtp-guides-links">
              <a
                v-for="guide in smtpGuides"
                :key="guide.href"
                class="text-link"
                :href="guide.href"
                target="_blank"
                rel="noopener noreferrer"
              >
                {{ guide.label }}<RadarIcon name="external" :size="12" />
              </a>
            </div>
            <p class="field-hint smtp-guides-note">
              若找不到应用专用密码，可能受组织账号或安全策略限制，请查看
              <a
                class="text-link"
                href="https://support.google.com/accounts/answer/185833?hl=zh-Hans"
                target="_blank"
                rel="noopener noreferrer"
                >Google 官方说明<RadarIcon name="external" :size="11" /></a
              >。
            </p>
          </details>
          <div class="form-field">
            <label for="channel-smtp-host">SMTP 服务器</label>
            <input
              id="channel-smtp-host"
              v-model="form.smtpHost"
              maxlength="255"
              :disabled="form.clearCredentials"
              placeholder="例如 smtp.example.com"
              required
            />
          </div>
          <div class="form-field">
            <label for="channel-smtp-port">SMTP 端口</label>
            <input
              id="channel-smtp-port"
              v-model.number="form.smtpPort"
              type="number"
              min="1"
              max="65535"
              :disabled="form.clearCredentials"
              required
            />
          </div>
          <div class="form-field">
            <label for="channel-smtp-security">加密方式</label>
            <select
              id="channel-smtp-security"
              v-model="form.smtpSecurity"
              :disabled="form.clearCredentials"
            >
              <option value="starttls">STARTTLS（推荐）</option>
              <option value="tls">TLS（465）</option>
            </select>
            <span class="field-hint">常用 587 + STARTTLS、465 + TLS；支持服务器自定义端口。</span>
          </div>
          <div class="form-field">
            <label for="channel-smtp-username">SMTP 用户名</label>
            <input
              id="channel-smtp-username"
              v-model="form.smtpUsername"
              maxlength="320"
              :disabled="form.clearCredentials"
              autocomplete="username"
              placeholder="通常是邮箱地址"
            />
            <span class="field-hint">用户名和密码留空保留；取消认证需清除全部配置后重新填写。</span>
          </div>
          <div class="form-field">
            <label for="channel-smtp-password">SMTP 密码</label>
            <input
              id="channel-smtp-password"
              v-model="form.smtpPassword"
              type="password"
              maxlength="4096"
              :disabled="form.clearCredentials"
              autocomplete="new-password"
              :placeholder="
                selected.smtpPasswordConfigured
                  ? '已配置 · 留空保留'
                  : '输入 SMTP 密码或应用专用密码'
              "
            />
          </div>
          <div class="form-field">
            <label for="channel-from-email">发件人地址</label>
            <input
              id="channel-from-email"
              v-model="form.fromEmail"
              type="email"
              maxlength="320"
              :disabled="form.clearCredentials"
              placeholder="alerts@example.com"
              required
            />
          </div>
          <div class="form-field full">
            <label for="channel-to-emails">收件人地址</label>
            <textarea
              id="channel-to-emails"
              v-model="form.toEmails"
              rows="2"
              maxlength="4000"
              :disabled="form.clearCredentials"
              placeholder="一个或多个地址，用逗号、分号或换行分隔"
              required
            />
            <span class="field-hint">仅通过服务端 SMTP 发信；浏览器不会保存邮箱密码。</span>
          </div>
        </template>
        <label class="integration-checkbox full"
          ><input
            v-model="form.clearCredentials"
            type="checkbox"
          />清除该渠道已保存的全部凭据</label
        >
        <p class="field-hint full">
          凭据不会回显，不在浏览器持久保存。关闭配置窗口会清空尚未提交的密钥。
        </p>
        <p v-if="configError" class="form-error full" role="alert">{{ configError }}</p>
        <div class="dialog-actions full">
          <button class="btn" type="button" :disabled="configBusy" @click="configOpen = false">
            取消</button
          ><button class="btn btn-primary" type="submit" :disabled="configBusy">
            {{ configBusy ? '保存中…' : '保存渠道配置' }}
          </button>
        </div>
      </form>
    </el-dialog>
    <section class="panel section-block">
      <div class="panel-heading">
        <div>
          <span class="section-number">02</span>
          <h2>通知记录</h2>
        </div>
        <span class="muted text-xs">最近 {{ number(notifications?.data.length) }} 条</span>
      </div>
      <DataState
        :loading="notificationsPending"
        :error="notificationsError"
        :empty="notifications?.data.length === 0"
        empty-text="暂无通知记录"
        @retry="refreshNotifications()"
        ><div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>通知 / 事件</th>
                <th>渠道</th>
                <th>状态</th>
                <th>尝试次数</th>
                <th>入队时间</th>
                <th>平台接受时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="notification in notifications?.data" :key="notification.id">
                <td>
                  <div class="notification-title">{{ notification.title }}</div>
                  <div v-if="notification.lastError" class="text-danger text-xs">
                    {{ notification.lastError }}
                  </div>
                  <StatusBadge v-if="notification.dataMode === 'fixture'" value="fixture" />
                </td>
                <td>
                  {{
                    channels?.data.find((channel) => channel.id === notification.channelId)?.name ??
                    '未知渠道'
                  }}
                </td>
                <td><StatusBadge :value="notification.status" /></td>
                <td class="mono">{{ notification.attempts }}</td>
                <td>{{ date(notification.queuedAt) }}</td>
                <td>{{ notification.acceptedAt ? date(notification.acceptedAt) : '尚未确认' }}</td>
                <td>
                  <button
                    v-if="notification.status === 'FAILED'"
                    class="text-link"
                    @click="retry(notification.id)"
                  >
                    重试<RadarIcon name="refresh" :size="13" /></button
                  ><span v-else class="muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div></DataState
      >
    </section>
  </div>
</template>
<style scoped>
.smtp-card-links,
.smtp-guides-links {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
}
.smtp-card-links {
  margin: -8px 0 16px;
}
.smtp-card-links .text-link {
  font-size: 10px;
}
.smtp-guides {
  padding: 12px 15px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 6px;
  min-width: 0;
}
.smtp-guides summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 11px;
}
.smtp-guides-heading {
  display: flex;
  align-items: flex-start;
  gap: 11px;
}
.smtp-guides-heading p {
  font-size: 11px;
  line-height: 1.9;
  margin: 12px 0 13px;
}
.smtp-guides code {
  overflow-wrap: anywhere;
}
.smtp-guides-note {
  margin: 12px 0 0;
}
.smtp-guides-note .text-link {
  display: inline;
  font-size: inherit;
}
.smtp-guides-note svg {
  display: inline-block;
  vertical-align: -1px;
  margin-left: 3px;
}
</style>
