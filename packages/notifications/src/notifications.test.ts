import { describe, expect, it, vi } from 'vitest';
import { TelegramProvider, BarkProvider, formatMessage } from './index.js';
const message = {
  title: '<b>untrusted</b>',
  description: 'Raw content',
  priority: 'P1',
  dataMode: 'live' as const,
  originalUrl: 'https://example.com',
};
describe('notification safety and acceptance semantics', () => {
  it('never sends fixture messages through Telegram', async () => {
    const fetcher = vi.fn();
    const result = await new TelegramProvider('test-token', 'test-chat', fetcher).send({
      ...message,
      dataMode: 'fixture',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.accepted).toBe(false);
  });
  it('sends plain text without platform HTML interpretation and records platform acceptance', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 123 } })));
    const result = await new TelegramProvider('test-token', 'test-chat', fetcher).send(message);
    const body = JSON.parse(fetcher.mock.calls[0]![1].body as string);
    expect(body.parse_mode).toBeUndefined();
    expect(body.text).toContain('<b>untrusted</b>');
    expect(result.accepted).toBe(true);
    expect(result.platformMessageId).toBe('123');
    expect(result).not.toHaveProperty('read');
  });
  it('preserves rate-limit cooldown and ambiguous timeouts', async () => {
    const rate = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 20 } }),
          { status: 429 },
        ),
      );
    expect(await new TelegramProvider('token', 'chat', rate).send(message)).toMatchObject({
      accepted: false,
      retryable: true,
      retryAfterMs: 20000,
    });
    const down = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await new TelegramProvider('token', 'chat', down).send(message)).toMatchObject({
      accepted: false,
      ambiguous: true,
      retryable: true,
    });
  });
  it('uses configured Bark endpoint and limits output length', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"code":200}'));
    expect(
      (await new BarkProvider('https://api.day.app/test-device', fetcher).send(message)).accepted,
    ).toBe(true);
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.day.app/test-device');
    expect(
      formatMessage({ ...message, description: 'a'.repeat(10000) }).length,
    ).toBeLessThanOrEqual(3900);
  });
});
it('does not interpret malformed Telegram success payload as a verified acceptance', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
  expect(await new TelegramProvider('token', 'chat', fetcher).send(message)).toMatchObject({
    accepted: false,
    retryable: false,
    ambiguous: true,
  });
});
