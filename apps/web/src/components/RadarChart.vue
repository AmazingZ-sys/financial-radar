<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useUi } from '../stores/ui';
echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, CanvasRenderer]);
const props = withDefaults(
  defineProps<{
    points: { time: string; value: number }[];
    height?: number;
    kind?: 'line' | 'bar';
    color?: string;
    unit?: string;
  }>(),
  { height: 220, kind: 'line', color: '#b9df8a', unit: '' },
);
const ui = useUi();
const root = ref<HTMLDivElement>();
let chart: echarts.ECharts | undefined;
let observer: ResizeObserver | undefined;
const options = computed(() => {
  const muted = ui.theme === 'dark' ? '#718293' : '#718096';
  const border = ui.theme === 'dark' ? '#202e3a' : '#e1e6e8';
  return {
    animationDuration: 400,
    grid: { top: 18, left: 12, right: 16, bottom: 22, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: ui.theme === 'dark' ? '#162330' : '#ffffff',
      borderColor: border,
      textStyle: { color: ui.theme === 'dark' ? '#e1e8ed' : '#1b2a38' },
      valueFormatter: (value: unknown) => `${String(value)} ${props.unit}`,
    },
    xAxis: {
      type: 'category',
      data: props.points.map((p) => p.time),
      boundaryGap: props.kind === 'bar',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 10, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitNumber: 4,
      axisLabel: { color: muted, fontSize: 10 },
      splitLine: { lineStyle: { color: border, type: 'dashed' } },
    },
    series: [
      {
        type: props.kind,
        data: props.points.map((p) => p.value),
        smooth: 0.3,
        showSymbol: false,
        barMaxWidth: 20,
        itemStyle: { color: props.color, borderRadius: [3, 3, 0, 0] },
        lineStyle: { width: 2, color: props.color },
        areaStyle:
          props.kind === 'line'
            ? {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                  { offset: 0, color: `${props.color}25` },
                  { offset: 1, color: `${props.color}00` },
                ]),
              }
            : undefined,
      },
    ],
  };
});
onMounted(() => {
  if (!root.value) return;
  chart = echarts.init(root.value);
  chart.setOption(options.value);
  observer = new ResizeObserver(() => chart?.resize());
  observer.observe(root.value);
});
watch(options, () => chart?.setOption(options.value));
onBeforeUnmount(() => {
  observer?.disconnect();
  chart?.dispose();
});
</script>
<template>
  <div
    ref="root"
    class="radar-chart"
    :style="{ height: `${height}px` }"
    role="img"
    :aria-label="`${points.length} 个数据点的${kind === 'bar' ? '柱状' : '趋势'}图`"
  />
</template>
