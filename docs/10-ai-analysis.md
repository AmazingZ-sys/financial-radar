# 10 · AI 辅助分析设计

设计版本：1.0 · 2026-11-02。

## 1. Provider 与输出

统一 `analyze(input, options)` 抽象，支持未配置的 disabled Provider、明确标注的 Fixture Provider，以及可配置 OpenAI-compatible HTTP Provider。管理员可在系统页配置公开 HTTPS 中转地址、model、推理强度（默认 XHigh，连接测试使用 Low）、timeout、JSON 模式、API Key 和预算；最大输出 token 由服务端限制。密钥加密存储且不回显，环境变量作为初始默认，后续任务读取数据库覆盖配置。动态地址经过 DNS 校验与固定地址出站，阻断私网、凭据 URL 和重定向。详细契约见 [25 可配置集成](25-configurable-integrations.md)。

结构化输出经 Zod 严格校验：summary、classification、relatedAssets、keyFacts（fact/inference/unsupported 标签）、evidenceIds、possibleImpact、uncertainty、riskWarnings、suggestedPriority、modelVersion、promptVersion。事实要关联输入中已给出的 evidenceIds；未知 ID、未知 URL、未提供的合约地址或参与条件拒绝或剥离并标记需人工复核。输出优先级是建议，不能覆盖确定性风险规则。

## 2. Prompt 与防注入

Prompt 版本入 Git，输入中来源正文作为不可信引用，要求禁止执行网页内指令/泄露配置；不提供密钥、内部日志、认证信息给模型。只允许基于可用证据概括，不能把模型推断变成 verified fact。网页中的链接仅作为输入证据，模型新造 URL 不显示为官方链接。JSON schema 限制长度、数组上限和枚举；解析失败视为分析失败，不降级为自由文本事实。

## 3. 异步、缓存与降级

事件持久化后以 eventId + evidence hash + model + promptVersion + 服务配置身份摘要为缓存键，切换中转地址或密钥不会复用原服务结果。analysis 队列指数退避、有限重试，模式不匹配的遗留任务直接跳过。未配置、超时、无效输出、预算超额时展示 DISABLED/FAILED/DEFERRED，核心采集/评分/通知继续。P0/P1 确定事件先发摘要，后续 AI 解读须单独遵循冷却和补充消息配置，不能反复通知。低优先级可仅分类摘要，日报异步按 UTC/用户时区窗口生成。

### 上游流式接收（2026-11-04）

- 新闻分析仍由后台 Worker 执行；向 Chat Completions 发送 `stream: true` 和 `stream_options.include_usage: true`。安全 HTTPS 传输在响应头到达后返回可读流，保留 DNS 固定、禁止重定向、取消底层连接与 2MB 响应上限。连接测试共享流式解析，但仍以 Low 进行短请求。
- 已有 `timeoutMs` 配置改为首包/连续无数据等待上限（1–60 秒），每次收到字节后重新计时；单次分析另有固定 10 分钟总上限，连接测试保留 60 秒总上限。收到心跳或 reasoning 增量可以续期，但 reasoning 不拼入分析正文。模型若在首包前完全无数据超过配置值，仍会明确超时。
- 增量 UTF-8 解码并按 SSE 事件边界解析，只拼接第一个 choice 的 `delta.content`；支持跨块事件、CRLF、注释心跳、空 choices 用量块。正常 `finish_reason: stop` 与 `[DONE]` 都到达才视为流式完成；截断、流内错误、长度上限、非法 JSON 或证据校验失败均拒绝持久化成功结果。不支持流式而直接返回完整 JSON 的兼容服务可解析其原响应，不自动重发收费请求。
- 仅在完整结构化输出通过 Zod 与证据校验后保存结果；没有 usage 时记未知。AI 使用独立的 `financial-radar-ai` 队列与两个执行槽，原队列保留采集/通知四个执行槽，旧队列遗留分析转投新队列。AI 运行与 outbox 恢复租约为 15 分钟，实际开始分析时刷新 outbox 租约，避免长流仍在处理时被恢复器提前重投。Fixture 不调用真实服务。

协议依据：[OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。上游流式不能保证供应商在首包前开始输出，也不能恢复供应商中断的同一次生成。

## 4. 成本与用量

请求前以配置单价估算上界并在数据库事务内预留每日预算，防止并发超额。结束用 Provider usage 记 input/output tokens 与估算金额；没有可靠 usage 时显示未知并保守释放/计费，不编造实际账单。每次预算、模型、单价版本入 run。单次上限、每日次数/Token/金额上限均可配置；超预算降级无需阻断事件。管理端展示调用量、失败率、缓存命中、预算消耗及“估算费用”字样。

## 5. 人工复核

分析 reviewStatus 为 UNREVIEWED/APPROVED/REJECTED，复核时间和管理员写审计。人工确认 AI 摘要不能替代官方来源确认。若初版没有人工编辑界面，应保留数据库字段并在验收矩阵明确界面未实现，不能声称已有完整审核流。
