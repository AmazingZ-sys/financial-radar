<script setup lang="ts">
import { ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { z } from 'zod';
import { ChannelSchema, NotificationSchema, type NotificationChannel } from '@radar/shared';
import { ElMessage } from 'element-plus';
import { api, write } from '../lib/api';
import { date, number } from '../lib/format';
import DataState from '../components/DataState.vue';
import RadarIcon from '../components/RadarIcon.vue';
import StatusBadge from '../components/StatusBadge.vue';
const client = useQueryClient();
const testBusy = ref('');
const {
  data: channels,
  isPending,
  error,
  refetch,
} = useQuery({
  queryKey: ['channels'],
  queryFn: () => api('/notification-channels', {}, z.array(ChannelSchema)),
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
async function toggle(channel: NotificationChannel) {
  try {
    await write(`/notification-channels/${channel.id}`, 'PATCH', { enabled: !channel.enabled });
    await client.invalidateQueries({ queryKey: ['channels'] });
    ElMessage.success('渠道状态已更新');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败');
  }
}
async function test(channel: NotificationChannel) {
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
        <span class="section-subtitle">密钥由服务器环境管理</span>
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
              ><RadarIcon :name="channel.provider === 'telegram' ? 'arrowUp' : 'bell'" :size="24"
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
          <p>{{ channel.description || '通知接口由服务端统一管理，前端不接触完整密钥。' }}</p>
          <div class="channel-foot">
            <span class="badge" :class="channel.configured ? 'badge-healthy' : 'badge-unknown'"
              ><span class="status-dot" :class="{ offline: !channel.configured }" />{{
                channel.configured ? '凭据已配置' : '未配置凭据'
              }}</span
            ><button
              class="text-link"
              :disabled="!channel.configured || !channel.enabled || testBusy === channel.id"
              @click="test(channel)"
            >
              {{ testBusy === channel.id ? '提交中…' : '发送测试'
              }}<RadarIcon name="arrow" :size="14" />
            </button>
          </div>
        </section></div
    ></DataState>
    <div class="notice-box">
      <RadarIcon name="shield" :size="17" />
      <p>
        “平台已接受”表示渠道 API
        确认接收请求，不代表用户已经收到或阅读。渠道凭据仅显示配置状态，修改请更新服务端环境变量。
      </p>
    </div>
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
