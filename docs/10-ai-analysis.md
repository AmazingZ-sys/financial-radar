# 10 · AI 辅助分析设计

设计版本：1.0 · 2026-11-02。

## 1. Provider 与输出

统一 `analyze(input, options)` 抽象，支持未配置的 disabled Provider、明确标注的 Fixture Provider，以及可配置 OpenAI-compatible HTTP Provider。配置 base URL、model、timeout、最大输出 token 和预算仅服务端可读；自定义 URL 必须由运维提供，防止 API SSRF。

结构化输出经 Zod 严格校验：summary、classification、relatedAssets、keyFacts（fact/inference/unsupported 标签）、evidenceIds、possibleImpact、uncertainty、riskWarnings、suggestedPriority、modelVersion、promptVersion。事实要关联输入中已给出的 evidenceIds；未知 ID、未知 URL、未提供的合约地址或参与条件拒绝或剥离并标记需人工复核。输出优先级是建议，不能覆盖确定性风险规则。

## 2. Prompt 与防注入

Prompt 版本入 Git，输入中来源正文作为不可信引用，要求禁止执行网页内指令/泄露配置；不提供密钥、内部日志、认证信息给模型。只允许基于可用证据概括，不能把模型推断变成 verified fact。网页中的链接仅作为输入证据，模型新造 URL 不显示为官方链接。JSON schema 限制长度、数组上限和枚举；解析失败视为分析失败，不降级为自由文本事实。

## 3. 异步、缓存与降级

事件持久化后以 eventId + evidence hash + model + promptVersion 为缓存键。analysis 队列指数退避、有限重试。未配置、超时、无效输出、预算超额时展示 DISABLED/FAILED/DEFERRED，核心采集/评分/通知继续。P0/P1 确定事件先发摘要，后续 AI 解读须单独遵循冷却和补充消息配置，不能反复通知。低优先级可仅分类摘要，日报异步按 UTC/用户时区窗口生成。

## 4. 成本与用量

请求前以配置单价估算上界并在数据库事务内预留每日预算，防止并发超额。结束用 Provider usage 记 input/output tokens 与估算金额；没有可靠 usage 时显示未知并保守释放/计费，不编造实际账单。每次预算、模型、单价版本入 run。单次上限、每日次数/Token/金额上限均可配置；超预算降级无需阻断事件。管理端展示调用量、失败率、缓存命中、预算消耗及“估算费用”字样。

## 5. 人工复核

分析 reviewStatus 为 UNREVIEWED/APPROVED/REJECTED，复核时间和管理员写审计。人工确认 AI 摘要不能替代官方来源确认。若初版没有人工编辑界面，应保留数据库字段并在验收矩阵明确界面未实现，不能声称已有完整审核流。
