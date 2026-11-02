# 08 · 事件处理与时间模型

设计版本：1.0 · 2026-11-02。

## 1. 顺序与持久化

采集 → 原始项 durable save → 正常化 → 严格资产身份去重/聚合 → 规则检测 → 来源验证 → 独立机会/风险计算 → 通知决策 → 持久化待发/outbox → Redis 队列 → 发送 → 保存 attempt/平台接受状态。AI 在标准事件保存后异步处理，可后续补充解释，不能阻塞主链路。

每次采集记录 ingestion_run 和 requestId/sourceId/cursor。单页已持久化但 checkpoint 未提交时可重新拉取；数据库幂等键防重复。正常化错误保留 raw_item 及错误状态供重放，不让坏项阻断整页。严格按 source 外部 ID 去重；无 ID 时 hash 规范化 URL/标题/时间/资产身份。

## 2. 时间语义

| 字段                     | 含义                                             |
| ------------------------ | ------------------------------------------------ |
| eventOccurredAt          | 事件真实发生时间；不知道为 null                  |
| sourcePublishedAt        | 来源公开发布时间；不知道为 null                  |
| firstSeenAt              | 此系统第一次观察到原始项时间，不可被后续采集覆盖 |
| collectedAt              | 本次采集时间                                     |
| normalizedAt             | 标准化完成时间                                   |
| detectedAt               | 规则/信号判定时间                                |
| queuedAt                 | 通知持久化入队时间                               |
| acceptedAt / deliveredAt | 平台接口接受时间；不表示用户阅读                 |

发现延迟 = firstSeenAt−sourcePublishedAt；处理延迟 = detectedAt−firstSeenAt；排队延迟 = attemptStartedAt−queuedAt；发送延迟 = acceptedAt−attemptStartedAt；端到端 = acceptedAt−sourcePublishedAt。缺失源时间不计算对应延迟，负值作为时钟/来源异常标记，不能取绝对值掩盖问题。分别统计 source/provider/priority 的 P50/P95 与有效样本数。

## 3. 去重与聚合

1. URL：去 fragment、已知追踪参数、默认端口；保留有语义路径和参数，不擅自小写路径。
2. 先比较 chain、contract/assetKey、transactionHash、block/inscription ID 和事件类型；冲突一律不合并。
3. 同源 externalId 或强身份键相同确定重复；URL 相同在合理时间窗合并来源。
4. 文本采用 Unicode 规范化、分词 token/Jaccard，相似度阈值可配置；只在类型/资产相符且时间窗内进行。纯标题相同不足以跨不同项目合并。
5. 独立来源应按组织/原始发布者去相关，同稿转载不能提高为多源确认。
6. 保存 canonicalEventId、聚合方法、版本、相似度和成员原始项，错误合并可追溯。

## 4. 并发与失败

源级租约减少重复拉取，但唯一约束是最终防线。DB transaction rollback 不前进游标。429 尊重 Retry-After，认证失败进入需配置状态而不是无穷重试。Redis 故障时业务待发留在 DB，恢复后扫描补投；Worker 崩溃后 BullMQ stalled 检测和 DB 租约恢复。发送超时结果未知时记为 RETRYING/UNKNOWN_ACCEPTANCE，由渠道幂等能力决定自动重试并在历史中说明可能重复。
