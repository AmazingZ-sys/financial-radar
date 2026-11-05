import { describe, expect, it } from 'vitest';
import { AIConfigSchema, AIConfigPatchSchema } from './integrations.js';

describe('AI reasoning configuration compatibility', () => {
  const legacyConfig = {
    name: 'Relay',
    enabled: true,
    baseUrl: 'https://relay.example/v1',
    model: 'model-a',
    timeoutMs: 20000,
    jsonMode: true,
    dailyBudgetUsd: 1,
    maxCallCostUsd: 0.1,
  };

  it('reads legacy settings as XHigh without resetting effort on unrelated PATCHes', () => {
    expect(AIConfigSchema.parse(legacyConfig).reasoningEffort).toBe('xhigh');
    const patch = AIConfigPatchSchema.parse({ name: 'Renamed' });
    expect(patch).not.toHaveProperty('reasoningEffort');
    expect(
      AIConfigSchema.parse({ ...legacyConfig, reasoningEffort: 'high', ...patch }).reasoningEffort,
    ).toBe('high');
    expect(AIConfigPatchSchema.parse({})).toEqual({});
  });

  it('rejects invalid effort without coercing it to the default', () => {
    for (const reasoningEffort of ['invalid', 'XHigh', '', null]) {
      expect(AIConfigPatchSchema.safeParse({ reasoningEffort }).success).toBe(false);
      expect(AIConfigSchema.safeParse({ ...legacyConfig, reasoningEffort }).success).toBe(false);
    }
  });

  it('defaults a missing daily call limit and preserves explicit limits on unrelated PATCHes', () => {
    expect(AIConfigSchema.parse(legacyConfig).maxDailyCalls).toBe(20);
    const patch = AIConfigPatchSchema.parse({ name: 'Renamed' });
    expect(patch).not.toHaveProperty('maxDailyCalls');
    for (const maxDailyCalls of [0, 1, 20, 500]) {
      expect(AIConfigPatchSchema.parse({ maxDailyCalls }).maxDailyCalls).toBe(maxDailyCalls);
      expect(AIConfigSchema.parse({ ...legacyConfig, maxDailyCalls, ...patch }).maxDailyCalls).toBe(
        maxDailyCalls,
      );
    }
  });

  it.each([-1, 501, 1.5, NaN, Infinity, '20', null])(
    'rejects invalid daily call limits (%s) without coercion',
    (maxDailyCalls) => {
      expect(AIConfigPatchSchema.safeParse({ maxDailyCalls }).success).toBe(false);
      expect(AIConfigSchema.safeParse({ ...legacyConfig, maxDailyCalls }).success).toBe(false);
    },
  );
});
