import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import './style.css';
import App from './App.vue';
import { router } from './router';
import { ApiError } from './lib/api';

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15000,
      refetchInterval: 30000,
      refetchOnWindowFocus: true,
      retry: (count, error) =>
        !(error instanceof ApiError && [400, 401, 403, 404].includes(error.status)) && count < 1,
    },
    mutations: { retry: false },
  },
});
createApp(App)
  .use(createPinia())
  .use(router)
  .use(VueQueryPlugin, { queryClient: client })
  .use(ElementPlus, { locale: zhCn })
  .mount('#app');
