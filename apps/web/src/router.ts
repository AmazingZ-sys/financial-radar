import { createRouter, createWebHistory } from 'vue-router';
import { useAuth } from './stores/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./pages/LoginPage.vue'), meta: { title: '登录' } },
    {
      path: '/',
      component: () => import('./pages/DashboardPage.vue'),
      meta: { title: '雷达总览', eyebrow: 'RADAR OVERVIEW' },
    },
    {
      path: '/events',
      component: () => import('./pages/EventsPage.vue'),
      meta: { title: '实时热点', eyebrow: 'INTELLIGENCE FEED' },
    },
    {
      path: '/events/:id',
      component: () => import('./pages/EventDetailPage.vue'),
      meta: { title: '事件详情', eyebrow: 'EVENT INTELLIGENCE' },
    },
    {
      path: '/projects',
      component: () => import('./pages/ProjectsPage.vue'),
      meta: { title: '早期机会', eyebrow: 'EARLY SIGNALS' },
    },
    {
      path: '/projects/:id',
      component: () => import('./pages/ProjectDetailPage.vue'),
      meta: { title: '项目观察', eyebrow: 'PROJECT DOSSIER' },
    },
    {
      path: '/markets',
      component: () => import('./pages/MarketsPage.vue'),
      meta: { title: '行情监控', eyebrow: 'MARKET OBSERVATORY' },
    },
    {
      path: '/calendar',
      component: () => import('./pages/CalendarPage.vue'),
      meta: { title: '经济日历', eyebrow: 'ECONOMIC CALENDAR' },
    },
    {
      path: '/rules',
      component: () => import('./pages/RulesPage.vue'),
      meta: { title: '预警规则', eyebrow: 'ALERT ENGINE' },
    },
    {
      path: '/notifications',
      component: () => import('./pages/NotificationsPage.vue'),
      meta: { title: '通知中心', eyebrow: 'DELIVERY CENTER' },
    },
    {
      path: '/sources',
      component: () => import('./pages/SourcesPage.vue'),
      meta: { title: '数据源', eyebrow: 'SOURCE NETWORK' },
    },
    {
      path: '/system',
      component: () => import('./pages/SystemPage.vue'),
      meta: { title: '系统管理', eyebrow: 'SYSTEM CONSOLE' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
router.beforeEach(async (to) => {
  const auth = useAuth();
  if (!auth.initialized) await auth.load();
  if (!auth.user && to.path !== '/login') return '/login';
  if (auth.user && to.path === '/login') return '/';
  return true;
});
router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '金融雷达')} · Financial Radar`;
});
