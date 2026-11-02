<script setup lang="ts">
import type { Project } from '../lib/models';
import { date, number, percent, relative } from '../lib/format';
import { participationStatus } from '../lib/participation';
import RadarIcon from './RadarIcon.vue';
import ScoreBar from './ScoreBar.vue';
import StatusBadge from './StatusBadge.vue';
defineProps<{ project: Project }>();
</script>
<template>
  <RouterLink :to="`/projects/${project.id}`" class="project-card"
    ><div class="project-card-top">
      <span class="project-avatar" :class="project.chain?.toLowerCase()">{{
        project.name?.slice(0, 1)
      }}</span>
      <div class="project-heading">
        <h3>{{ project.name }}</h3>
        <p>{{ project.chain }} <span>·</span> {{ project.protocol }}</p>
      </div>
      <RadarIcon name="arrowUp" :size="18" class="muted" />
    </div>
    <div class="project-tags">
      <StatusBadge :value="project.stage" /><StatusBadge
        :value="project.verificationStatus"
      /><StatusBadge v-if="project.dataMode === 'fixture'" value="fixture" />
    </div>
    <div class="project-scores">
      <ScoreBar :value="project.opportunityScore" compact /><ScoreBar
        :value="project.riskScore"
        risk
        compact
      />
    </div>
    <div v-if="project.riskFlagged" class="risk-note">
      <RadarIcon name="warning" :size="13" />存在重要风险，请优先核验
    </div>
    <div class="project-metrics">
      <div>
        <span>独立参与者</span><b>{{ number(project.participants) }}</b>
      </div>
      <div>
        <span>参与变化</span
        ><b :class="(project.participantGrowthPct ?? 0) > 0 ? 'text-teal' : ''">{{
          percent(project.participantGrowthPct)
        }}</b>
      </div>
      <div>
        <span>铸造进度</span
        ><b>{{ project.mintProgress === null ? '未知' : `${number(project.mintProgress, 1)}%` }}</b>
      </div>
    </div>
    <div
      class="participation-window"
      :class="`text-${participationStatus(project).tone}`"
      :title="`记录开始 ${date(project.startsAt, true)}；记录结束 ${date(project.endsAt, true)}`"
    >
      <RadarIcon name="clock" :size="12" /><span>{{ participationStatus(project).text }}</span
      ><time v-if="project.endsAt">{{ date(project.endsAt) }}</time>
    </div>
    <div class="project-card-foot">
      <span><RadarIcon name="clock" :size="12" /> {{ relative(project.firstSeenAt) }}发现</span
      ><span>查看证据 <RadarIcon name="arrow" :size="13" /></span></div
  ></RouterLink>
</template>
