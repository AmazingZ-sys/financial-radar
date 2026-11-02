import { defineStore } from 'pinia';
import { ref } from 'vue';
import { z } from 'zod';
import { api, setCsrfToken, write } from '../lib/api';

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  csrfToken: z.string(),
});
type User = z.infer<typeof userSchema>;
export const useAuth = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const initialized = ref(false);
  async function load() {
    try {
      const result = await api('/auth/me', {}, userSchema);
      user.value = result.data;
      setCsrfToken(result.data.csrfToken);
    } catch {
      user.value = null;
    } finally {
      initialized.value = true;
    }
  }
  async function login(email: string, password: string) {
    await write('/auth/login', 'POST', { email, password });
    await load();
    if (!user.value) throw new Error('会话未建立，请检查 Cookie 与服务配置。');
  }
  async function logout() {
    try {
      await write('/auth/logout', 'POST');
    } finally {
      user.value = null;
      setCsrfToken('');
    }
  }
  return { user, initialized, load, login, logout };
});
