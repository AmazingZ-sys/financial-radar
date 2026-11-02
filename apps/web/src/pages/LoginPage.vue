<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '../stores/auth';
import { useUi } from '../stores/ui';
import RadarIcon from '../components/RadarIcon.vue';
const auth = useAuth();
const router = useRouter();
const ui = useUi();
const email = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');
async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await auth.login(email.value, password.value);
    password.value = '';
    await router.replace('/');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '登录失败，请重试';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="login-page">
    <button class="icon-btn login-theme" aria-label="切换主题" @click="ui.toggleTheme">
      <RadarIcon :name="ui.theme === 'dark' ? 'sun' : 'moon'" />
    </button>
    <div class="login-story">
      <div class="login-brand"><RadarIcon name="radar" :size="36" /> FINANCIAL RADAR</div>
      <div class="login-orbit">
        <span /><span /><span /><i /><b />
        <div><RadarIcon name="radar" :size="88" /></div>
      </div>
      <span class="eyebrow">THE SIGNAL BEFORE THE NOISE</span>
      <h1>每一次发现，<br />都有迹可循。</h1>
      <p>连接金融市场与链上世界。<br />发现早期信号，追溯每一条证据，让研究先行一步。</p>
      <div class="login-principles">
        <span><RadarIcon name="shield" :size="16" />证据驱动</span
        ><span><RadarIcon name="opportunity" :size="16" />早期发现</span
        ><span><RadarIcon name="eye" :size="16" />风险独立</span>
      </div>
    </div>
    <div class="login-form-area">
      <form class="login-form" @submit.prevent="submit">
        <span class="eyebrow">YOUR RESEARCH WORKSPACE</span>
        <h2>欢迎回到雷达</h2>
        <p>登录管理控制台，继续你的发现。</p>
        <label for="email">管理员邮箱</label
        ><input
          id="email"
          v-model="email"
          type="email"
          autocomplete="username"
          placeholder="you@example.com"
          required
          maxlength="254"
        /><label for="password">登录密码</label
        ><input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="输入管理员密码"
          required
          minlength="8"
        />
        <div v-if="error" class="form-error" role="alert">
          <RadarIcon name="warning" :size="16" />{{ error }}
        </div>
        <button class="btn btn-primary login-submit" type="submit" :disabled="busy">
          {{ busy ? '正在建立安全会话…' : '登录工作台' }}<RadarIcon name="arrow" :size="18" />
        </button>
        <div class="login-help">
          <RadarIcon name="shield" :size="15" /><span
            >仅限授权管理员访问。账号由服务端初始化，私密凭据不会保存在浏览器。</span
          >
        </div>
      </form>
      <div class="login-footer">FINANCIAL RADAR <span>金融热点雷达与早期机会发现系统</span></div>
    </div>
  </div>
</template>
