import { ref } from 'vue';
export const displayTimezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone);
export const labels: Record<string, string> = {
  DISCOVERED: '首次发现',
  UNVERIFIED: '待验证',
  VERIFIED: '已验证',
  EARLY_STAGE: '早期阶段',
  ACTIVE: '活动进行中',
  COMPLETED: '活动结束',
  TRADING: '进入交易',
  WATCHING: '持续观察',
  RISK_FLAGGED: '风险标记',
  INACTIVE: '已失活',
  NEW_PROTOCOL: '新协议出现',
  NEW_TOKEN_DEPLOYED: '新代币部署',
  TOKEN_STATE_SNAPSHOT: '代币状态采样',
  MINT_STARTED: '铸造开放',
  MINT_PROGRESS_ACCELERATED: '铸造进度加速',
  MINT_WINDOW_ENDING: '早期参与窗口即将结束',
  WINDOW_ENDING: '早期参与窗口即将结束',
  EARLY_WINDOW_ENDING: '早期参与窗口即将结束',
  PARTICIPATION_WINDOW_ENDING: '早期参与窗口即将结束',
  PARTICIPATION_WINDOW_EXPIRING: '早期参与窗口即将结束',
  PARTICIPATION_WINDOW_EXPIRED: '已核验参与窗口结束',
  WINDOW_EXPIRED: '参与窗口已结束',
  STAGE_CHANGED: '项目阶段变化',
  UNIQUE_PARTICIPANTS_SPIKE: '独立参与增长',
  LIQUIDITY_ADDED: '新增流动性',
  LIQUIDITY_REMOVED: '流动性撤出',
  VOLUME_SPIKE: '交易量异常增长',
  PROJECT_LAUNCHED: '项目正式开放',
  PROJECT_TRUST_CHANGED: '项目可信度变化',
  SOCIAL_MOMENTUM: '社区关注增长',
  OFFICIAL_ANNOUNCEMENT: '官方公告',
  NEWS: '热点新闻',
  SOCIAL_POST: 'X 原创帖子',
  X_HOT_TOPIC: 'X 讨论候选',
  EXCHANGE_LISTING: '交易所上市',
  PENDING: '等待处理',
  SENDING: '发送中',
  SENT: '平台已接受',
  FAILED: '失败',
  RETRYING: '重试中',
  CANCELLED: '已取消',
  SKIPPED: '已跳过',
  SUCCESS: '成功',
  HEALTHY: '正常',
  DEGRADED: '降级',
  DOWN: '离线',
  DISABLED: '已禁用',
  UNKNOWN: '未知',
  healthy: '正常',
  degraded: '降级',
  down: '离线',
  disabled: '已禁用',
  unknown: '未知',
  fixture: 'Fixture',
  live: '真实来源',
  bitcoin: 'Bitcoin',
  ethereum: 'Ethereum',
  solana: 'Solana',
  macro: '全球宏观',
  crypto: '加密资产',
  finance: '财经市场',
  technology: '科技动态',
  world: '全球热点',
  gold: '黄金',
  oil: '原油',
  treasury: '美国国债',
  news: '财经资讯',
  chain: '链上数据',
  participants: '独立参与者',
  participantGrowthPct: '独立参与增长（%）',
  mintProgress: '铸造进度（%）',
  mintProgressDelta: '铸造进度变化',
  mintRate: '铸造速率',
  mintAcceleration: '铸造加速度',
  liquidityUsd: '流动性（USD）',
  liquidityChangePct: '流动性变化（%）',
  windowSeconds: '指标窗口（秒）',
  conditionsVerified: '参与条件已核验',
  startsAt: '窗口开始',
  endsAt: '窗口结束',
};
export const label = (value?: string | null) =>
  value ? (labels[value] ?? value.replaceAll('_', ' ')) : '未知';
export function number(value?: number | null, digits = 0): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : new Intl.NumberFormat('zh-CN', {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      }).format(value);
}
export function percent(value?: number | null, digits = 1): string {
  return value === null || value === undefined
    ? '—'
    : `${value > 0 ? '+' : ''}${number(value, digits)}%`;
}
export function date(value?: string | null, full = false): string {
  if (!value || Number.isNaN(new Date(value).getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: displayTimezone.value,
    month: '2-digit',
    day: '2-digit',
    ...(full ? { year: 'numeric' as const } : {}),
    hour: '2-digit',
    minute: '2-digit',
    ...(full ? { second: '2-digit' as const } : {}),
    hour12: false,
  }).format(new Date(value));
}
export function relative(value?: string | null): string {
  if (!value) return '时间未知';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return '时间未知';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
export const safeUrl = (value?: string | null): string | undefined => {
  try {
    const url = new URL(value ?? '');
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
};
