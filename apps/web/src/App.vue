<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import { SettingsSchema } from '@radar/shared';
import { api } from './lib/api';
import { displayTimezone } from './lib/format';
import { useAuth } from './stores/auth';
import { useUi } from './stores/ui';
import RadarIcon from './components/RadarIcon.vue';

const auth = useAuth();
const ui = useUi();
const route = useRoute();
const router = useRouter();
const clock = ref(new Date());
const enabled = computed(() => Boolean(auth.user));
const { data: status, error: statusError } = useQuery({
  queryKey: ['system-status'],
  queryFn: () => api<Record<string, unknown>>('/system/status'),
  enabled,
  refetchInterval: 15000,
});
const { data: settings } = useQuery({
  queryKey: ['settings'],
  queryFn: () => api('/settings', {}, SettingsSchema),
  enabled,
});
watch(
  () => settings.value?.data.timezone,
  (value) => {
    if (value) displayTimezone.value = value;
  },
);
const fixture = computed(
  () =>
    status.value?.meta?.dataMode === 'fixture' ||
    status.value?.data.dataMode === 'fixture' ||
    status.value?.data.mode === 'fixture',
);
const links = [
  { path: '/', name: '雷达总览', icon: 'grid' },
  { path: '/events', name: '实时热点', icon: 'feed' },
  { path: '/projects', name: '早期机会', icon: 'opportunity', tag: 'CORE' },
  { path: '/markets', name: '行情监控', icon: 'chart' },
  { path: '/calendar', name: '经济日历', icon: 'calendar' },
  { path: '/rules', name: '预警规则', icon: 'rules' },
  { path: '/notifications', name: '通知中心', icon: 'bell' },
  { path: '/sources', name: '数据源', icon: 'source' },
  { path: '/system', name: '系统管理', icon: 'settings' },
];
let interval: ReturnType<typeof setInterval> | undefined;
const unauthorized = () => {
  auth.user = null;
  void router.replace('/login');
};
onMounted(() => {
  interval = setInterval(() => {
    clock.value = new Date();
  }, 1000);
  window.addEventListener('radar:unauthorized', unauthorized);
});
onBeforeUnmount(() => {
  if (interval) clearInterval(interval);
  window.removeEventListener('radar:unauthorized', unauthorized);
});
watch(
  () => route.path,
  () => {
    ui.sidebarOpen = false;
  },
);
async function logout() {
  await auth.logout();
  await router.replace('/login');
}
</script>
<template>
  <RouterView v-if="route.path === '/login'" />
  <div v-else class="app-shell">
    <div v-if="ui.sidebarOpen" class="sidebar-backdrop" @click="ui.sidebarOpen = false" />
    <aside class="sidebar" :class="{ open: ui.sidebarOpen }">
      <RouterLink to="/" class="brand"
        ><span class="brand-symbol"><RadarIcon name="radar" :size="28" /></span
        ><span
          >FINANCIAL<span class="brand-second">RADAR<span class="brand-square" /></span></span
      ></RouterLink>
      <div class="sidebar-caption">INTELLIGENCE WORKSPACE</div>
      <nav aria-label="主导航">
        <RouterLink
          v-for="link in links"
          :key="link.path"
          :to="link.path"
          :class="['nav-link', { 'nav-separated': link.path === '/rules' }]"
          :exact-active-class="link.path === '/' ? 'active' : undefined"
          :active-class="link.path !== '/' ? 'active' : undefined"
          ><RadarIcon :name="link.icon" :size="18" /><span>{{ link.name }}</span
          ><small v-if="link.tag">{{ link.tag }}</small></RouterLink
        >
      </nav>
      <div class="sidebar-bottom">
        <div class="monitor-card">
          <div class="monitor-card-head">
            <span class="status-dot" :class="{ offline: statusError || !status }" />{{
              statusError ? '服务连接异常' : status ? '系统连接正常' : '正在连接'
            }}<RadarIcon name="radar" :size="15" />
          </div>
          <p>让证据先于市场情绪</p>
          <div class="monitor-line">
            <span :style="{ width: status && !statusError ? '100%' : '0%' }" />
          </div>
        </div>
        <div class="sidebar-user">
          <span class="user-avatar">R</span>
          <div>
            <b>研究工作台</b><span>{{ auth.user?.email }}</span>
          </div>
          <button class="icon-btn" aria-label="退出登录" @click="logout">
            <RadarIcon name="logout" :size="17" />
          </button>
        </div>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <div class="topbar-left">
          <button class="icon-btn mobile-menu" aria-label="打开导航" @click="ui.sidebarOpen = true">
            <RadarIcon name="menu" /></button
          ><span class="breadcrumb"
            >工作空间 <span>/</span> <b>{{ route.meta.title }}</b></span
          >
        </div>
        <div class="topbar-right">
          <span class="system-indicator"
            ><span class="status-dot" :class="{ offline: statusError || !status }" />{{
              statusError
                ? '连接异常'
                : status
                  ? fixture
                    ? 'FIXTURE MODE'
                    : 'CONNECTED'
                  : 'CONNECTING'
            }}</span
          ><time class="topbar-clock"
            >{{ clock.toLocaleTimeString('en-GB', { hour12: false, timeZone: displayTimezone }) }}
            <span>{{ displayTimezone }}</span></time
          ><span class="topbar-divider" /><button
            class="icon-btn"
            :aria-label="ui.theme === 'dark' ? '切换浅色主题' : '切换深色主题'"
            @click="ui.toggleTheme"
          >
            <RadarIcon :name="ui.theme === 'dark' ? 'sun' : 'moon'" :size="18" /></button
          ><RouterLink to="/notifications" class="icon-btn" aria-label="通知中心"
            ><RadarIcon name="bell" :size="18" /></RouterLink
          ><span class="user-avatar small">R</span>
        </div>
      </header>
      <div v-if="fixture" class="fixture-banner">
        <RadarIcon name="code" :size="15" /><b>演示数据 · Fixture</b
        ><span>当前为明确标记的测试数据，不代表实时行情或真实投资机会。</span>
      </div>
      <main class="workspace"><RouterView /></main>
      <footer class="app-footer">
        <span><span class="status-dot tiny" />FINANCIAL RADAR <b>·</b> 从信号，到洞察。</span
        ><span>仅供信息研究 · 不执行交易或链上签名</span>
      </footer>
    </div>
  </div>
</template>
