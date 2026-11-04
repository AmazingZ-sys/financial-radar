import type { AIReasoningEffort } from '@radar/shared';
import { z } from 'zod';

export const AI_ANALYSIS_TOTAL_TIMEOUT_MS = 10 * 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type ChatCompletionConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  reasoningEffort: AIReasoningEffort;
  jsonMode: boolean;
  maxTokens: number;
  messages: { role: string; content: string }[];
  totalTimeoutMs?: number;
};
export type ChatCompletionResult = {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

const UsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  })
  .nullish();
const StreamChunkSchema = z.object({
  choices: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      delta: z.object({ content: z.string().nullish(), refusal: z.string().nullish() }).optional(),
      finish_reason: z.string().nullish(),
    }),
  ),
  usage: UsageSchema,
});
const CompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: UsageSchema,
});

function parseJSON(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('AI provider 返回了无效 JSON 响应');
  }
}

function checkFinishReason(reason: string | null | undefined) {
  if (reason === 'length') throw new Error('AI provider 输出达到 token 上限');
  if (reason != null && reason !== 'stop') throw new Error('AI provider 输出未正常完成');
}

// The explicit race also bounds custom transports that do not settle immediately on abort.
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) {
      operation.catch(() => {});
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** Collect a complete, bounded Chat Completions response; never expose partial JSON as a result. */
export async function requestChatCompletion(
  config: ChatCompletionConfig,
  fetcher: typeof fetch = fetch,
): Promise<ChatCompletionResult> {
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout>;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new Error('AI provider 等待数据超时')),
      config.timeoutMs,
    );
  };
  resetIdle();
  const totalTimer = setTimeout(
    () => controller.abort(new Error('AI provider 请求超过总时长上限')),
    config.totalTimeoutMs ?? AI_ANALYSIS_TOTAL_TIMEOUT_MS,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const pendingResponse = fetcher(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      signal: controller.signal,
      redirect: 'error',
      body: JSON.stringify({
        model: config.model,
        reasoning_effort: config.reasoningEffort,
        temperature: 0,
        max_tokens: config.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...(config.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: config.messages,
      }),
    });
    // Dispose a late response if a transport ignored the cancellation signal during connect.
    void pendingResponse.then(
      (response) => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
      },
      () => {},
    );
    const response = await withAbort(pendingResponse, controller.signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`AI provider HTTP ${response.status}`);
    }
    if (!response.body) throw new Error('AI provider 响应缺少有效 completion');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    const read = async () => {
      const chunk = await withAbort(reader!.read(), controller.signal);
      if (!chunk.done && chunk.value.byteLength > 0) {
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('AI provider 响应超过 2MB 限制');
        resetIdle();
      }
      return chunk;
    };
    const decode = (value?: Uint8Array, streaming = false) => {
      try {
        return decoder.decode(value, { stream: streaming });
      } catch {
        throw new Error('AI provider 响应编码无效');
      }
    };
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      // Some compatible relays return a single JSON completion despite stream:true. Use it once.
      let text = '';
      for (;;) {
        const chunk = await read();
        if (chunk.done) break;
        text += decode(chunk.value, true);
      }
      text += decode();
      const payload = CompletionSchema.safeParse(parseJSON(text));
      if (!payload.success) throw new Error('AI provider 响应缺少有效 completion');
      const first = payload.data.choices[0]!;
      checkFinishReason(first.finish_reason);
      if (!first.message.content.trim()) throw new Error('AI provider 响应缺少有效 completion');
      return {
        content: first.message.content,
        inputTokens: payload.data.usage?.prompt_tokens ?? null,
        outputTokens: payload.data.usage?.completion_tokens ?? null,
      };
    }

    let content = '';
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let stopped = false;
    let completed = false;
    let pending = '';
    let dataLines: string[] = [];
    let eventType = '';
    const dispatch = () => {
      if (eventType === 'error') throw new Error('AI provider 流式返回错误');
      eventType = '';
      if (!dataLines.length) return;
      const data = dataLines.join('\n');
      dataLines = [];
      if (data.trim() === '[DONE]') {
        if (!stopped) throw new Error('AI provider 流式响应未完整结束');
        completed = true;
        return;
      }
      const json = parseJSON(data);
      if (typeof json === 'object' && json !== null && 'error' in json && json.error != null)
        throw new Error('AI provider 流式返回错误');
      const chunk = StreamChunkSchema.safeParse(json);
      if (!chunk.success) throw new Error('AI provider 流式响应无效');
      if (chunk.data.usage) {
        inputTokens = chunk.data.usage.prompt_tokens;
        outputTokens = chunk.data.usage.completion_tokens;
      }
      for (const choice of chunk.data.choices) {
        if (choice.index !== 0) continue;
        if (choice.delta?.refusal) throw new Error('AI provider 输出未正常完成');
        if (choice.delta?.content) {
          if (stopped) throw new Error('AI provider 流式响应无效');
          content += choice.delta.content;
        }
        checkFinishReason(choice.finish_reason);
        if (choice.finish_reason === 'stop') stopped = true;
      }
    };
    const line = (value: string) => {
      if (!value) return dispatch();
      if (value.startsWith(':')) return;
      const colon = value.indexOf(':');
      const name = colon < 0 ? value : value.slice(0, colon);
      let fieldValue = colon < 0 ? '' : value.slice(colon + 1);
      if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
      if (name === 'data') dataLines.push(fieldValue);
      if (name === 'event') eventType = fieldValue;
    };
    const feed = (value: string, eof = false) => {
      pending += value;
      while (!completed) {
        const match = /[\r\n]/.exec(pending);
        if (!match) break;
        const index = match.index;
        // Keep a final CR until the next chunk so a split CRLF is one line ending.
        if (!eof && pending[index] === '\r' && index === pending.length - 1) break;
        const endLength = pending[index] === '\r' && pending[index + 1] === '\n' ? 2 : 1;
        const value = pending.slice(0, index);
        pending = pending.slice(index + endLength);
        line(value);
      }
      if (eof && !completed) {
        if (pending) line(pending);
        pending = '';
        dispatch();
      }
    };
    while (!completed) {
      const chunk = await read();
      if (chunk.done) {
        feed(decode(), true);
        break;
      }
      feed(decode(chunk.value, true));
    }
    if (!completed || !stopped) throw new Error('AI provider 流式响应未完整结束');
    if (!content.trim()) throw new Error('AI provider 响应缺少有效 completion');
    return { content, inputTokens, outputTokens };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof Error && /^AI provider /.test(error.message)) throw error;
    throw new Error('AI provider 请求或响应读取失败');
  } finally {
    clearTimeout(idleTimer!);
    clearTimeout(totalTimer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
