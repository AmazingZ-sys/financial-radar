import { describe, expect, it, vi } from 'vitest';
import { TelegramProvider, BarkProvider, EmailProvider, formatMessage } from './index.js';
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
  it('sends live email through the configured SMTP transport and preserves acceptance semantics', async () => {
    const sendMail = vi.fn().mockResolvedValue({
      messageId: '<smtp-1@example.com>',
      accepted: ['admin@example.com', 'ops@example.com'],
      rejected: [],
    });
    const close = vi.fn();
    const factory = vi.fn().mockReturnValue({ sendMail, close });
    const provider = new EmailProvider(
      {
        smtpHost: 'smtp.example.com',
        smtpPort: 2525,
        smtpSecurity: 'starttls',
        smtpUsername: 'alerts@example.com',
        smtpPassword: 'app-password',
        fromEmail: 'alerts@example.com',
        toEmails: ['admin@example.com', 'ops@example.com'],
      },
      factory,
    );
    const result = await provider.send(message);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com',
        port: 2525,
        secure: false,
        requireTLS: true,
        auth: { user: 'alerts@example.com', pass: 'app-password' },
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'alerts@example.com',
        to: ['admin@example.com', 'ops@example.com'],
        text: expect.stringContaining('Financial Radar'),
      }),
    );
    expect(result).toMatchObject({
      accepted: true,
      retryable: false,
      platformMessageId: '<smtp-1@example.com>',
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it('does not call an SMTP transport for fixture messages', async () => {
    const sendMail = vi.fn();
    const provider = new EmailProvider(
      {
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpSecurity: 'starttls',
        fromEmail: 'alerts@example.com',
        toEmails: ['admin@example.com'],
      },
      () => ({ sendMail }),
    );
    const result = await provider.send({ ...message, dataMode: 'fixture' });
    expect(sendMail).not.toHaveBeenCalled();
    expect(result).toMatchObject({ accepted: false, retryable: false });
  });
  it('records partial SMTP acceptance without retrying accepted recipients or exposing addresses', async () => {
    const sendMail = vi.fn().mockResolvedValue({
      accepted: ['private-admin@example.com'],
      rejected: ['private-ops@example.com'],
    });
    const close = vi.fn();
    const result = await new EmailProvider(
      {
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpSecurity: 'starttls',
        fromEmail: 'alerts@example.com',
        toEmails: ['private-admin@example.com', 'private-ops@example.com'],
      },
      () => ({ sendMail, close }),
    ).send(message);
    expect(result).toMatchObject({ accepted: true, retryable: false });
    expect(result.error).toContain('部分收件人（1/2）');
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(close).toHaveBeenCalledOnce();
  });
  it('never marks malformed or fully rejected SMTP results as accepted', async () => {
    for (const response of [
      { messageId: '<id@example.com>' },
      { accepted: [], rejected: ['admin@example.com'] },
    ]) {
      const sendMail = vi.fn().mockResolvedValue(response);
      const result = await new EmailProvider(
        {
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpSecurity: 'starttls',
          fromEmail: 'alerts@example.com',
          toEmails: ['admin@example.com'],
        },
        () => ({ sendMail }),
      ).send(message);
      expect(result).toMatchObject({ accepted: false, retryable: false });
    }
  });
  it.each([
    [{ responseCode: 450 }, true],
    [{ responseCode: 454 }, true],
    [{ code: 'EAUTH', responseCode: 454 }, true],
    [{ code: 'EAUTH', responseCode: 535 }, false],
    [{ responseCode: 503 }, true],
    [{ responseCode: 550 }, false],
    [{ code: 'EAUTH' }, false],
    [{ code: 'CERT_HAS_EXPIRED' }, false],
    [{ code: 'ECONNRESET' }, true],
  ])('classifies SMTP errors safely: %j', async (error, retryable) => {
    const sendMail = vi
      .fn()
      .mockRejectedValue({ ...error, message: 'password private@example.com' });
    const close = vi.fn();
    const result = await new EmailProvider(
      {
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        smtpSecurity: 'tls',
        fromEmail: 'alerts@example.com',
        toEmails: ['admin@example.com'],
      },
      () => ({ sendMail, close }),
    ).send(message);
    expect(result).toMatchObject({ accepted: false, retryable });
    expect(JSON.stringify(result)).not.toContain('private@example.com');
    expect(close).toHaveBeenCalledOnce();
  });
  it('closes stalled SMTP sessions within the worker lease and records uncertain acceptance', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    try {
      const sendMail = vi.fn().mockReturnValue(new Promise(() => {}));
      const resultPromise = new EmailProvider(
        {
          smtpHost: 'smtp.example.com',
          smtpPort: 587,
          smtpSecurity: 'starttls',
          fromEmail: 'alerts@example.com',
          toEmails: ['admin@example.com'],
        },
        () => ({ sendMail, close }),
      ).send(message);
      await vi.advanceTimersByTimeAsync(25000);
      expect(await resultPromise).toMatchObject({
        accepted: false,
        retryable: true,
        ambiguous: true,
      });
      expect(close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
