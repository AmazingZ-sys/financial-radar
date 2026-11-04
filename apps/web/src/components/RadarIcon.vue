<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string> = {
  calendar: 'M4 5h16v16H4zM8 2v6M16 2v6M4 10h16M8 14h2M14 14h2M8 18h2',
  radar:
    'M12 2a10 10 0 1 0 10 10M12 6a6 6 0 1 0 6 6M12 10a2 2 0 1 0 2 2M12 12 21 3M12 2v4M2 12h4M12 18v4M18 12h4',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  feed: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5',
  opportunity: 'm13 2-9 12h7l-1 8 10-12h-7l1-8Z',
  chart: 'M3 3v18h18M6 15l4-5 4 3 6-8',
  rules: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  source: 'M4 4h6v6H4zM14 14h6v6h-6zM14 4h6v6h-6zM4 14h6v6H4zM10 7h4M7 10v4M17 10v4M10 17h4',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M10 2h4l1 3 3 1 3-1 2 4-2 3 1 3-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-3-1-3 2-4 3 1 3-1z',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15M16 16l5 5',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  arrowUp: 'M6 18 18 6M6 6h12v12',
  chevron: 'm9 5 7 7-7 7',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-2l2 2M4 17l2 2a8 8 0 0 0 13-2',
  shield: 'm12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6l9-4ZM8 12l3 3 5-6',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M12 6v6l4 2',
  external: 'M14 3h7v7M21 3 10 14M10 3H3v18h18v-7',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2',
  moon: 'M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13Z',
  menu: 'M3 6h18M3 12h18M3 18h18',
  close: 'm6 6 12 12M6 18 18 6',
  plus: 'M12 5v14M5 12h14',
  check: 'm5 12 4 4L19 6',
  warning: 'm12 3 10 18H2L12 3ZM12 9v5M12 17v1',
  logout: 'M9 4H3v16h6M9 12h12m-4-4 4 4-4 4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  users:
    'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M2 21v-3a7 7 0 0 1 14 0v3M17 4a4 4 0 0 1 0 7M22 21v-3a7 7 0 0 0-4-6',
  link: 'm10 13 4-4M8 15l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 9l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
  wallet: 'M3 6V4h15v4M3 6h18v15H3V6ZM15 11h6v5h-6z',
  edit: 'm16 3 5 5L9 20l-6 1 1-6L16 3ZM13 6l5 5',
  trash: 'M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  code: 'm8 5-6 7 6 7M16 5l6 7-6 7M14 3l-4 18',
};
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] ?? paths.radar" />
  </svg>
</template>
