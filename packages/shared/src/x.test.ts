import { describe, expect, it } from 'vitest';
import {
  DEFAULT_X_CONFIG,
  XConfigPatchSchema,
  XConfigSchema,
  XSessionCookiesSchema,
  mergeXConfig,
} from './x.js';

describe('X authorized session input', () => {
  it('accepts only the two needed cookie values and returns a canonical string', () => {
    expect(XSessionCookiesSchema.parse(' ct0=synthetic-csrf; auth_token=synthetic-auth; ')).toBe(
      'auth_token=synthetic-auth; ct0=synthetic-csrf',
    );
    expect(
      XConfigPatchSchema.parse({ sessionCookies: 'auth_token=synthetic; ct0=synthetic' }),
    ).toEqual({ sessionCookies: 'auth_token=synthetic; ct0=synthetic' });
    expect(XConfigPatchSchema.parse({ pollIntervalSeconds: 900 })).toEqual({
      pollIntervalSeconds: 900,
    });
  });
  it('rejects full browser cookies, duplicates, missing values and header injection', () => {
    for (const value of [
      '',
      'auth_token=synthetic',
      'ct0=synthetic',
      'auth_token=; ct0=synthetic',
      'auth_token=synthetic; ct0=',
      'auth_token=synthetic; auth_token=other',
      'auth_token=synthetic; ct0=synthetic; lang=en',
      'auth_token=synthetic; ; ct0=synthetic',
      'Cookie: auth_token=synthetic; ct0=synthetic',
      'auth_token=synthetic\r\nInjected=value; ct0=synthetic',
      'auth_token=synthetic; ct0=white space',
      'auth_token="synthetic"; ct0=synthetic',
    ])
      expect(XSessionCookiesSchema.safeParse(value).success).toBe(false);
    expect(XConfigPatchSchema.safeParse({ bearerToken: 'old-official-token' }).success).toBe(false);
    expect(XConfigPatchSchema.safeParse({ collectorUrl: 'https://api.x.com' }).success).toBe(false);
  });
});

describe('X polling interval configuration', () => {
  it('requires bounded ordered endpoints and defaults to ten through twenty minutes', () => {
    expect(DEFAULT_X_CONFIG.pollIntervalMinSeconds).toBe(600);
    expect(DEFAULT_X_CONFIG.pollIntervalMaxSeconds).toBe(1200);
    expect(XConfigSchema.parse(DEFAULT_X_CONFIG)).toEqual(DEFAULT_X_CONFIG);
    for (const [minimum, maximum] of [
      [299, 1200],
      [600, 86401],
      [1201, 1200],
      [600.5, 1200],
      [600, 1200.5],
    ])
      expect(
        XConfigSchema.safeParse({
          ...DEFAULT_X_CONFIG,
          pollIntervalMinSeconds: minimum,
          pollIntervalMaxSeconds: maximum,
        }).success,
      ).toBe(false);
    const { pollIntervalMaxSeconds: _maximum, ...incomplete } = DEFAULT_X_CONFIG;
    expect(XConfigSchema.safeParse(incomplete).success).toBe(false);
    expect(
      mergeXConfig({}, { pollIntervalMinSeconds: 300, pollIntervalMaxSeconds: 300 }),
    ).toMatchObject({ pollIntervalMinSeconds: 300, pollIntervalMaxSeconds: 300 });
  });
  it('reads a legacy single value without rewriting it and caps its upper endpoint', () => {
    const stored = { pollIntervalSeconds: 901, dailyRequestLimit: 52 };
    expect(mergeXConfig(stored)).toMatchObject({
      pollIntervalMinSeconds: 901,
      pollIntervalMaxSeconds: 1352,
      dailyRequestLimit: 52,
    });
    expect(stored).toEqual({ pollIntervalSeconds: 901, dailyRequestLimit: 52 });
    expect(mergeXConfig({}, { pollIntervalSeconds: 60000 })).toMatchObject({
      pollIntervalMinSeconds: 60000,
      pollIntervalMaxSeconds: 86400,
    });
    expect(mergeXConfig({ ...DEFAULT_X_CONFIG, pollIntervalSeconds: 900 })).toEqual(
      DEFAULT_X_CONFIG,
    );
  });
  it('preserves the opposite endpoint for partial updates and validates the merged range', () => {
    expect(mergeXConfig({ ...DEFAULT_X_CONFIG }, { pollIntervalMinSeconds: 800 })).toMatchObject({
      pollIntervalMinSeconds: 800,
      pollIntervalMaxSeconds: 1200,
    });
    expect(mergeXConfig({ ...DEFAULT_X_CONFIG }, { pollIntervalMaxSeconds: 900 })).toMatchObject({
      pollIntervalMinSeconds: 600,
      pollIntervalMaxSeconds: 900,
    });
    expect(() => mergeXConfig({ ...DEFAULT_X_CONFIG }, { pollIntervalMinSeconds: 1201 })).toThrow(
      '最小采集间隔不能大于最大采集间隔',
    );
    expect(() => mergeXConfig({ ...DEFAULT_X_CONFIG }, { pollIntervalMaxSeconds: 599 })).toThrow(
      '最小采集间隔不能大于最大采集间隔',
    );
    expect(
      XConfigPatchSchema.safeParse({ pollIntervalSeconds: 900, pollIntervalMinSeconds: 600 })
        .success,
    ).toBe(false);
  });
});
