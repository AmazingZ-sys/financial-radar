import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

export const useUi = defineStore('ui', () => {
  const theme = ref(localStorage.getItem('radar-theme') === 'light' ? 'light' : 'dark');
  const sidebarOpen = ref(false);
  watch(
    theme,
    (value) => {
      document.documentElement.dataset.theme = value;
      localStorage.setItem('radar-theme', value);
    },
    { immediate: true },
  );
  function toggleTheme() {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }
  return { theme, sidebarOpen, toggleTheme };
});
