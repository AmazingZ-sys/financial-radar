export interface ParticipationWindow {
  stage: string;
  conditionsVerified?: boolean;
  verificationStatus?: string;
  startsAt?: string | null;
  endsAt?: string | null;
}

export function participationStatus(project: ParticipationWindow, now = Date.now()) {
  if (project.stage === 'COMPLETED') return { text: '活动已结束', tone: 'muted' };
  if (project.stage === 'INACTIVE') return { text: '已停止跟踪', tone: 'muted' };
  const startsAt = project.startsAt ? Date.parse(project.startsAt) : Number.NaN;
  const endsAt = project.endsAt ? Date.parse(project.endsAt) : Number.NaN;
  if (
    (project.startsAt && !Number.isFinite(startsAt)) ||
    (project.endsAt && !Number.isFinite(endsAt)) ||
    (Number.isFinite(startsAt) && Number.isFinite(endsAt) && startsAt >= endsAt)
  )
    return { text: '窗口时间异常 · 需重新核验', tone: 'amber' };
  if (Number.isFinite(endsAt) && endsAt <= now) return { text: '已到记录结束时间', tone: 'amber' };
  if (!project.conditionsVerified) return { text: '参与窗口待核验', tone: 'muted' };
  if (project.verificationStatus !== 'VERIFIED')
    return { text: '条件已核验 · 官方来源待验证', tone: 'amber' };
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt))
    return { text: '参与条件已核验 · 时间不完整', tone: 'muted' };
  if (startsAt > now) return { text: '已核验窗口 · 尚未开始', tone: 'teal' };
  if (endsAt - now <= 3600_000) return { text: '已核验窗口 · 即将结束', tone: 'amber' };
  return { text: '已核验的开放窗口', tone: 'teal' };
}
