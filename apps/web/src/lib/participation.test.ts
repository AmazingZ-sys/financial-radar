import { describe, expect, it } from 'vitest';
import { participationStatus } from './participation';

const now = Date.parse('2026-11-02T04:00:00Z');
const known = {
  stage: 'ACTIVE',
  conditionsVerified: true,
  verificationStatus: 'VERIFIED',
  startsAt: '2026-11-02T03:00:00Z',
  endsAt: '2026-11-02T06:00:00Z',
};
describe('participation evidence is independent of project verification', () => {
  it('does not advertise a window without independently verified conditions', () => {
    expect(participationStatus({ ...known, conditionsVerified: false }, now).text).toBe(
      '参与窗口待核验',
    );
  });
  it('does not infer opening from an incomplete time range', () => {
    expect(participationStatus({ ...known, endsAt: null }, now).text).toContain('时间不完整');
  });
  it('keeps official-source verification separate from condition verification', () => {
    expect(participationStatus({ ...known, verificationStatus: 'UNVERIFIED' }, now).text).toBe(
      '条件已核验 · 官方来源待验证',
    );
  });
  it('shows a verified interval and highlights the approaching boundary', () => {
    expect(participationStatus(known, now).text).toBe('已核验的开放窗口');
    expect(participationStatus({ ...known, endsAt: '2026-11-02T04:30:00Z' }, now).text).toContain(
      '即将结束',
    );
  });
  it('respects completed stage and a past recorded end time', () => {
    expect(participationStatus({ ...known, stage: 'COMPLETED' }, now).text).toBe('活动已结束');
    expect(participationStatus({ ...known, endsAt: '2026-11-02T03:30:00Z' }, now).text).toBe(
      '已到记录结束时间',
    );
  });
  it('rejects malformed and reversed timestamps instead of confirming a window', () => {
    expect(participationStatus({ ...known, startsAt: 'invalid' }, now).text).toBe(
      '窗口时间异常 · 需重新核验',
    );
    expect(participationStatus({ ...known, startsAt: '2026-11-02T07:00:00Z' }, now).text).toBe(
      '窗口时间异常 · 需重新核验',
    );
    expect(participationStatus({ ...known, startsAt: known.endsAt }, now).text).toBe(
      '窗口时间异常 · 需重新核验',
    );
  });
});
