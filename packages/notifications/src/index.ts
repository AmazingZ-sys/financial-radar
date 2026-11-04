import nodemailer from 'nodemailer';
import { Socket } from 'node:net';

export type NotificationMessage = {
  title: string;
  description: string;
  priority: string;
  assets?: string[];
  confidence?: number;
  stage?: string;
  firstSeenAt?: string;
  sourcePublishedAt?: string | null;
  opportunityScore?: number;
  riskScore?: number;
  riskFlags?: string[];
  originalUrl?: string;
  detailUrl?: string;
  dataMode: 'live' | 'fixture';
};
export type SendResult = {
  accepted: boolean;
  platformMessageId?: string;
  acceptedAt?: string;
  retryable: boolean;
  retryAfterMs?: number;
  error?: string;
  ambiguous?: boolean;
};
export interface NotificationProvider {
  name: string;
  send(message: NotificationMessage): Promise<SendResult>;
}
export function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
export function formatMessage(message: NotificationMessage) {
  const lines = [
    `${message.dataMode === 'fixture' ? '【Fixture 测试 · 非实时】' : '【Financial Radar】'} ${message.priority}`,
    message.title,
    message.description,
    `资产：${message.assets?.join(' / ') || '未知'} · 阶段：${message.stage || '不适用'}`,
    `发现：${message.firstSeenAt || '未知'}`,
    `来源发布：${message.sourcePublishedAt || '未知'}`,
    `置信度：${message.confidence === undefined ? '未知' : Math.round(message.confidence * 100) + '%'}`,
    `机会 ${message.opportunityScore ?? '未知'} / 风险 ${message.riskScore ?? '未知'}`,
    `风险：${message.riskFlags?.join('、') || '未完成完整风险审查，未知风险仍存在'}`,
    '参与条件、费用以已验证来源为准；不提供签名或自动交易。',
  ];
  if (message.originalUrl && /^https:\/\//.test(message.originalUrl) && message.dataMode === 'live')
    lines.push(`来源：${message.originalUrl}`);
  if (message.detailUrl && /^https:\/\//.test(message.detailUrl))
    lines.push(`详情：${message.detailUrl}`);
  return lines.join('\n').slice(0, 3900);
}
async function post(
  url: string,
  body: unknown,
  fetcher: typeof fetch,
): Promise<{ response?: Response; body?: Record<string, unknown>; error?: string }> {
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    let data: Record<string, unknown> = {};
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      /* A non-JSON platform response remains a failed attempt. */
    }
    return { response, body: data };
  } catch {
    return { error: '渠道请求超时或网络中断；平台是否接受未知' };
  }
}
export class TelegramProvider implements NotificationProvider {
  name = 'telegram';
  constructor(
    private token?: string,
    private chatId?: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  async send(message: NotificationMessage): Promise<SendResult> {
    if (message.dataMode === 'fixture')
      return { accepted: false, retryable: false, error: 'Fixture 安全保护：未向真实渠道发送' };
    if (!this.token || !this.chatId)
      return { accepted: false, retryable: false, error: 'Telegram 未配置' };
    const result = await post(
      `https://api.telegram.org/bot${this.token}/sendMessage`,
      {
        chat_id: this.chatId,
        text: formatMessage(message),
        link_preview_options: { is_disabled: true },
      },
      this.fetcher,
    );
    if (result.error)
      return { accepted: false, retryable: true, ambiguous: true, error: result.error };
    const response = result.response!;
    const body = result.body!;
    if (response.ok && body.ok === true) {
      const msg = body.result as { message_id?: unknown } | null | undefined;
      if (!msg || !Number.isInteger(msg.message_id))
        return {
          accepted: false,
          retryable: false,
          ambiguous: true,
          error: 'Telegram成功响应缺少有效message_id，接受状态无法核验',
        };
      return {
        accepted: true,
        retryable: false,
        platformMessageId: String(msg.message_id),
        acceptedAt: new Date().toISOString(),
      };
    }
    const params = body.parameters as { retry_after?: number } | undefined;
    return {
      accepted: false,
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: (params?.retry_after ?? 0) * 1000,
      error: `Telegram HTTP ${response.status} / code ${String(body.error_code ?? 'unknown')}`,
    };
  }
}
export class FeishuProvider implements NotificationProvider {
  name = 'feishu';
  constructor(
    private webhook?: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  async send(message: NotificationMessage): Promise<SendResult> {
    if (message.dataMode === 'fixture')
      return { accepted: false, retryable: false, error: 'Fixture 安全保护：未发送' };
    if (
      !this.webhook ||
      !/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(this.webhook)
    )
      return {
        accepted: false,
        retryable: false,
        error: '飞书 webhook 未配置或不是允许的官方地址',
      };
    const r = await post(
      this.webhook,
      { msg_type: 'text', content: { text: formatMessage(message) } },
      this.fetcher,
    );
    return r.error
      ? { accepted: false, retryable: true, ambiguous: true, error: r.error }
      : {
          accepted: r.response!.ok && r.body!.code === 0,
          retryable: r.response!.status === 429 || r.response!.status >= 500,
          acceptedAt: r.response!.ok && r.body!.code === 0 ? new Date().toISOString() : undefined,
          error:
            r.response!.ok && r.body!.code === 0
              ? undefined
              : `飞书 HTTP ${r.response!.status} / code ${String(r.body!.code)}`,
        };
  }
}
export class BarkProvider implements NotificationProvider {
  name = 'bark';
  constructor(
    private serverUrl?: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  async send(message: NotificationMessage): Promise<SendResult> {
    if (message.dataMode === 'fixture')
      return { accepted: false, retryable: false, error: 'Fixture 安全保护：未发送' };
    if (!this.serverUrl) return { accepted: false, retryable: false, error: 'Bark 未配置' };
    const endpoint = new URL(this.serverUrl);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname === '/'
    )
      return { accepted: false, retryable: false, error: 'Bark 需要完整HTTPS设备推送地址' };
    const r = await post(
      endpoint.toString(),
      { title: message.title, body: formatMessage(message), group: 'Financial Radar' },
      this.fetcher,
    );
    const accepted = !r.error && r.response!.ok && r.body!.code === 200;
    return {
      accepted,
      retryable: !!r.error || r.response?.status === 429 || (r.response?.status ?? 0) >= 500,
      ambiguous: !!r.error,
      acceptedAt: accepted ? new Date().toISOString() : undefined,
      error: accepted ? undefined : (r.error ?? `Bark HTTP ${r.response!.status}`),
    };
  }
}
export type EmailConfig = {
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: 'tls' | 'starttls';
  smtpUsername?: string;
  smtpPassword?: string;
  fromEmail: string;
  toEmails: string[];
};
type MailTransport = {
  sendMail: (message: { from: string; to: string[]; subject: string; text: string }) => Promise<{
    messageId?: string;
    accepted?: unknown[];
    rejected?: unknown[];
    rejectedErrors?: { responseCode?: number }[];
  }>;
  close?: () => void;
};
const SMTP_DEADLINE_MS = 25000;
const permanentSmtpErrors = new Set([
  'EAUTH',
  'ETLS',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
function createSmtpTransport(options: Record<string, unknown>): MailTransport {
  // Nodemailer's SMTP transport close() does not abort its active connection.
  // Owning the underlying socket lets the total deadline stop in-flight delivery too.
  const socket = new Socket();
  const transport = nodemailer.createTransport({ ...options, socket });
  return {
    sendMail: (message) => transport.sendMail(message),
    close: () => {
      socket.destroy();
      transport.close();
    },
  };
}
/** SMTP email provider. Credentials are supplied by the server-side worker only. */
export class EmailProvider implements NotificationProvider {
  name = 'email';
  constructor(
    private readonly email: EmailConfig,
    private readonly transportFactory: (
      options: Record<string, unknown>,
    ) => MailTransport = createSmtpTransport,
  ) {}
  async send(message: NotificationMessage): Promise<SendResult> {
    if (message.dataMode === 'fixture')
      return { accepted: false, retryable: false, error: 'Fixture 安全保护：未向真实渠道发送' };
    if (!this.email.smtpHost || !this.email.fromEmail || this.email.toEmails.length === 0)
      return { accepted: false, retryable: false, error: '邮箱 SMTP 未配置' };
    if (
      /[\r\n]/.test(this.email.fromEmail) ||
      this.email.toEmails.some((address) => /[\r\n]/.test(address))
    )
      return { accepted: false, retryable: false, error: '邮箱地址包含非法换行' };
    let transport: MailTransport | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const secure = this.email.smtpSecurity === 'tls';
      transport = this.transportFactory({
        host: this.email.smtpHost,
        port: this.email.smtpPort,
        secure,
        requireTLS: !secure,
        auth:
          this.email.smtpUsername || this.email.smtpPassword
            ? { user: this.email.smtpUsername ?? '', pass: this.email.smtpPassword ?? '' }
            : undefined,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 10000,
      });
      const result = await Promise.race([
        transport.sendMail({
          from: this.email.fromEmail,
          to: this.email.toEmails,
          subject: message.title.replace(/[\r\n]+/g, ' ').slice(0, 200),
          text: formatMessage(message),
        }),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('SMTP deadline')), SMTP_DEADLINE_MS);
        }),
      ]);
      const acceptedCount = result.accepted?.length ?? 0;
      const rejectedCount = result.rejected?.length ?? 0;
      if (acceptedCount === 0)
        return {
          accepted: false,
          retryable:
            rejectedCount > 0 &&
            result.rejectedErrors?.length === rejectedCount &&
            result.rejectedErrors.every(
              (error) => (error.responseCode ?? 0) >= 400 && (error.responseCode ?? 0) < 500,
            ),
          ambiguous: rejectedCount === 0,
          error: 'SMTP 响应未确认接受任何收件人；未记为已接受',
        };
      return {
        accepted: true,
        retryable: false,
        platformMessageId: result.messageId,
        acceptedAt: new Date().toISOString(),
        error:
          rejectedCount > 0 || acceptedCount < this.email.toEmails.length
            ? `SMTP 服务器仅接受部分收件人（${acceptedCount}/${this.email.toEmails.length}）；未接受的收件人不会自动重试`
            : undefined,
      };
    } catch (error) {
      const responseCode =
        typeof error === 'object' && error && 'responseCode' in error
          ? Number((error as { responseCode?: unknown }).responseCode)
          : 0;
      const code =
        typeof error === 'object' && error && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
      const permanent = permanentSmtpErrors.has(code) || code.startsWith('ERR_TLS_');
      const retryable =
        !permanent &&
        (responseCode === 0 || (responseCode >= 400 && responseCode < 500) || responseCode === 503);
      return {
        accepted: false,
        retryable,
        ambiguous: !permanent && responseCode === 0,
        error: '邮箱 SMTP 投递失败；请检查服务器配置和收件地址',
      };
    } finally {
      if (deadline) clearTimeout(deadline);
      try {
        transport?.close?.();
      } catch {
        // SMTP outcome remains authoritative; never leak close errors or credentials.
      }
    }
  }
}
export class FixtureNotificationProvider implements NotificationProvider {
  name = 'fixture';
  async send(message: NotificationMessage): Promise<SendResult> {
    if (message.dataMode !== 'fixture')
      return { accepted: false, retryable: false, error: 'Fixture provider 拒绝 live 消息' };
    return {
      accepted: false,
      retryable: false,
      error: 'SIMULATED：已验证模板，未向平台发送或假记为 SENT',
    };
  }
}
