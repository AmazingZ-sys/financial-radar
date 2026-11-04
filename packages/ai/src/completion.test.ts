import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompatibleAIProvider, FixtureAIProvider } from './index.js';
import { requestChatCompletion, type ChatCompletionConfig } from './completion.js';

const config: ChatCompletionConfig = {
  baseUrl: 'https://relay.example/v1/',
  apiKey: 'synthetic-test-key',
  model: 'synthetic-model',
  timeoutMs: 100,
  totalTimeoutMs: 1000,
  reasoningEffort: 'xhigh',
  jsonMode: true,
  maxTokens: 1000,
  messages: [{ role: 'user', content: 'Synthetic connection test' }],
};
const encoder = new TextEncoder();
const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const delta = (content: string, finishReason: string | null = null) => ({
  choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
});
const complete = (content = '{"ok":true}') => event(delta(content, 'stop')) + 'data: [DONE]\n\n';
function sse(body: string | ReadableStream<Uint8Array>) {
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
function fetchResponse(response: Response): typeof fetch {
  return async () => response;
}

describe('streaming Chat Completions collection', () => {
  afterEach(() => vi.useRealTimers());

  it('collects fragmented UTF-8/SSE, ignores reasoning and other choices, and validates evidence', async () => {
    const input = {
      eventId: 'event',
      assets: ['BTC'],
      evidence: [
        {
          id: 'e1',
          title: '已核验来源',
          text: '事实引用',
          url: 'https://example.com/release',
          availableAt: '2026-01-01T00:00:00Z',
        },
      ],
    };
    const output = (await new FixtureAIProvider().analyze(input)).result;
    const serialized = JSON.stringify(output);
    const wire = (
      ': heartbeat\n\n' +
      event({ choices: [{ index: 0, delta: { reasoning_content: 'private reasoning' } }] }) +
      event({ choices: [{ index: 1, delta: { content: 'ignore this choice' } }] }) +
      event(delta(serialized.slice(0, 17))) +
      event(delta(serialized.slice(17), 'stop')) +
      event({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 50 } }) +
      'data: [DONE]\n\n'
    ).replaceAll('\n', '\r\n');
    const bytes = encoder.encode(wire);
    let offset = 0;
    let request: RequestInit | undefined;
    const fetcher: typeof fetch = async (_url, options) => {
      request = options;
      return sse(
        new ReadableStream({
          pull(controller) {
            // One byte per chunk exercises UTF-8 and CRLF boundaries deterministically.
            if (offset === bytes.length) controller.close();
            else controller.enqueue(bytes.slice(offset, ++offset));
          },
        }),
      );
    };
    const result = await new CompatibleAIProvider(
      config.baseUrl,
      config.apiKey,
      config.model,
      fetcher,
      1000,
    ).analyze(input);
    expect(result.result).toEqual({ ...output, modelVersion: config.model });
    expect(result).toMatchObject({ inputTokens: 120, outputTokens: 50 });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'xhigh',
    });
  });

  it('keeps usage unknown when the relay omits it and accepts multiline SSE data', async () => {
    const wire =
      'event: message\ndata: {"choices":\ndata: [{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    await expect(requestChatCompletion(config, fetchResponse(sse(wire)))).resolves.toEqual({
      content: 'ok',
      inputTokens: null,
      outputTokens: null,
    });
  });

  it('accepts a relay JSON response once without making a second paid request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    await expect(requestChatCompletion(config, fetcher)).resolves.toEqual({
      content: '{"ok":true}',
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    event(delta('{"ok":true}')),
    event(delta('{"ok":true}', 'stop')),
    event(delta('{"ok":true}')) + 'data: [DONE]\n\n',
  ])('rejects truncated streams even when accumulated content is valid JSON', async (wire) => {
    await expect(requestChatCompletion(config, fetchResponse(sse(wire)))).rejects.toThrow(
      'AI provider 流式响应未完整结束',
    );
  });

  it.each(['length', 'content_filter', 'tool_calls'])('rejects %s termination', async (reason) => {
    const wire = event(delta('{"ok":true}', reason)) + 'data: [DONE]\n\n';
    await expect(requestChatCompletion(config, fetchResponse(sse(wire)))).rejects.toThrow(
      reason === 'length' ? 'token 上限' : '未正常完成',
    );
  });

  it('rejects a JSON fallback truncated at the token limit despite nonempty content', async () => {
    await expect(
      requestChatCompletion(
        config,
        fetchResponse(
          Response.json({
            choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'length' }],
          }),
        ),
      ),
    ).rejects.toThrow('token 上限');
  });

  it.each([
    'data: not-json-containing-untrusted-secret\n\n',
    event({ choices: [{ index: 0, delta: { content: { secret: 'untrusted-secret' } } }] }),
    event({ error: { message: 'untrusted-secret' } }),
    'event: error\ndata: untrusted-secret\n\n',
  ])('does not expose malformed data or provider error bodies in thrown errors', async (wire) => {
    const error = await requestChatCompletion(config, fetchResponse(sse(wire))).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('AI provider');
    expect(String(error)).not.toContain('untrusted-secret');
  });

  it('cancels on HTTP failure without exposing the response body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(
      requestChatCompletion(config, fetchResponse(new Response(body, { status: 429 }))),
    ).rejects.toThrow('AI provider HTTP 429');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels the stream after DONE without waiting for the server to close its socket', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(complete()));
      },
      cancel,
    });
    await expect(requestChatCompletion(config, fetchResponse(sse(body)))).resolves.toMatchObject({
      content: '{"ok":true}',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('bounds response size before parsing and cancels the source', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel,
    });
    await expect(requestChatCompletion(config, fetchResponse(sse(body)))).rejects.toThrow(
      '2MB 限制',
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('masks network/body read errors and rejects invalid UTF-8', async () => {
    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('network-error-with-secret'));
      },
    });
    await expect(requestChatCompletion(config, fetchResponse(sse(failed)))).rejects.toThrow(
      'AI provider 请求或响应读取失败',
    );
    await expect(
      requestChatCompletion(config, fetchResponse(new Response(new Uint8Array([0xff])))),
    ).rejects.toThrow('AI provider 响应编码无效');
  });

  it('allows total generation time to exceed the idle timeout while chunks keep arriving', async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(encoder.encode(': heartbeat\n\n')), 70);
        setTimeout(
          () =>
            controller.enqueue(
              encoder.encode(
                event({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' } }] }),
              ),
            ),
          140,
        );
        setTimeout(() => controller.enqueue(encoder.encode(complete())), 210);
      },
    });
    const result = expect(requestChatCompletion(config, fetchResponse(sse(body)))).resolves.toEqual(
      {
        content: '{"ok":true}',
        inputTokens: null,
        outputTokens: null,
      },
    );
    await vi.advanceTimersByTimeAsync(220);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a stalled request before headers arrive, even if the transport ignores abort', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = (_url, options) => {
      signal = options?.signal;
      return new Promise<Response>(() => {});
    };
    const result = expect(requestChatCompletion(config, fetcher)).rejects.toThrow('等待数据超时');
    await vi.advanceTimersByTimeAsync(101);
    await result;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a stalled stream after its last bytes', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.enqueue(encoder.encode(event(delta('partial')))), 70);
      },
      cancel,
    });
    const result = expect(requestChatCompletion(config, fetchResponse(sse(body)))).rejects.toThrow(
      '等待数据超时',
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(21);
    await result;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces a total deadline even while heartbeat data keeps the connection active', async () => {
    vi.useFakeTimers();
    let timer: ReturnType<typeof setInterval>;
    const cancel = vi.fn(() => clearInterval(timer));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => controller.enqueue(encoder.encode(': heartbeat\n\n')), 40);
      },
      cancel,
    });
    const result = expect(
      requestChatCompletion({ ...config, totalTimeoutMs: 250 }, fetchResponse(sse(body))),
    ).rejects.toThrow('总时长上限');
    await vi.advanceTimersByTimeAsync(251);
    await result;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
