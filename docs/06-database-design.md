# 06 · 数据库设计

设计版本：1.0 · 2026-11-02。必须在创建业务 Schema / Migration 之前保存此文档。

## 1. 通用规范

PostgreSQL；UUID 主键（由服务端生成），所有业务时间用 timestamptz UTC，前端按用户时区渲染。createdAt/updatedAt 为审计时间，不替代事件时间。金融金额/数量与高精度链上数值用 decimal 或字符串，不使用浮点保存精确资金数据。DTO 中有限精度评分允许 number。

ownerId 关联 users；单管理员也保留所有者边界。密钥从环境注入，数据库仅保存配置状态/环境变量别名，不返回真实值。Session 存 token 的 SHA-256，密码使用含随机 salt 的 scrypt。JSONB 用于原始载荷、指标快照、条件和版本化评分明细；过滤频繁字段必须独立列并索引。

## 2. 实体与索引

| 实体                             | 核心字段 / 约束与索引                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| users                            | id, email/username UNIQUE, passwordHash, role, enabled                                                                                                                             |
| user_sessions                    | id, userId FK, tokenHash UNIQUE, expiresAt；userId/expiresAt 索引                                                                                                                  |
| user_settings                    | userId UNIQUE, timezone, theme, locale, notificationPreferences JSONB                                                                                                              |
| watchlists / watchlist_items     | ownerId, name；(watchlistId,assetKey) UNIQUE                                                                                                                                       |
| data_sources                     | id, slug UNIQUE, connectorType, enabled, interval, mode, config public JSONB                                                                                                       |
| source_checkpoints               | sourceId UNIQUE, cursor JSONB, committedAt                                                                                                                                         |
| source_health_records            | sourceId, status, latencyMs, errorCode, observedAt；(sourceId,observedAt)                                                                                                          |
| ingestion_runs                   | sourceId, startedAt, finishedAt, status, fetched, inserted, errorSummary                                                                                                           |
| raw_items                        | sourceId, externalId, payload JSONB, payloadHash, publishedAt, firstSeenAt, collectedAt；(sourceId,externalId) UNIQUE                                                              |
| events                           | fingerprint UNIQUE, type, title, text, originalUrl, distinct times, verificationStatus, confidence, severity, analysisStatus, dataMode；(firstSeenAt DESC), (severity,firstSeenAt) |
| event_sources                    | eventId, sourceId, rawItemId, url, sourcePublishedAt；(eventId,rawItemId) UNIQUE                                                                                                   |
| event_assets                     | eventId, assetKey；(eventId,assetKey) UNIQUE；assetKey 索引                                                                                                                        |
| event_evidence                   | eventId, rawItemId, factType, value JSONB, observedAt, sourcePublishedAt                                                                                                           |
| event_analyses                   | eventId, aiRunId, result JSONB, reviewStatus, createdAt                                                                                                                            |
| event_clusters                   | canonicalEventId, memberEventId UNIQUE, method, similarity, version                                                                                                                |
| projects                         | assetKey UNIQUE, chain, name, protocol, stage, verificationStatus, riskFlagged, watching, firstSeenAt, conditions JSONB, startsAt, endsAt                                          |
| project_assets / project_sources | projectId, chain+address/assetKey；来源只存已见证据                                                                                                                                |
| project_lifecycle_events         | projectId, fromStage, toStage, reason, evidenceIds, occurredAt, recordedAt                                                                                                         |
| project_metrics                  | projectId, observedAt, sourceId, payload JSONB；(projectId,observedAt,sourceId) UNIQUE                                                                                             |
| opportunity_signals              | dedupKey UNIQUE, projectId/eventId, type, detectedAt, evidenceIds, opportunityScore, breakdown, scoringVersion；(projectId,detectedAt)                                             |
| risk_assessments                 | projectId/eventId, score, flags JSONB, unknowns, evidenceIds, version, assessedAt                                                                                                  |
| alert_rules                      | ownerId, name, enabled, conditions JSONB, cooldownSeconds, priority, version                                                                                                       |
| alert_rule_versions              | ruleId, version, snapshot JSONB, createdAt；(ruleId,version) UNIQUE                                                                                                                |
| alert_triggers                   | ruleId, ruleVersion, eventId/signalId, reason, detectedAt, dedupKey UNIQUE                                                                                                         |
| notification_channels            | ownerId, provider, enabled, configStatus, publicConfig JSONB                                                                                                                       |
| notifications                    | dedupKey UNIQUE, triggerId, channelId, templateVersion, payload snapshot, status, attempts, nextAttemptAt, queuedAt, acceptedAt, lastError；(status,nextAttemptAt)                 |
| notification_attempts            | notificationId, attemptNo, requestId, startedAt, finishedAt, platformMessageId, responseCode, outcome；(notificationId,attemptNo) UNIQUE                                           |
| ai_analysis_runs                 | eventId, provider, model, promptVersion, cacheKey, status, tokens/cost, error, startedAt, completedAt                                                                              |
| ai_usage_records                 | runId UNIQUE, day, model, inputTokens, outputTokens, estimatedCost；day 索引                                                                                                       |
| audit_logs                       | actorId, action, entityType, entityId, requestId, redactedDetails, createdAt                                                                                                       |
| system_settings                  | key UNIQUE, version, public JSONB；不得保存明文生产密钥                                                                                                                            |
| market_observations              | assetKey, sourceId, observedAt, value, unit, delaySeconds, dataMode；(assetKey,sourceId,observedAt) UNIQUE                                                                         |
| outbox_jobs                      | dedupKey UNIQUE, kind, entityId, status, availableAt, lockedUntil, attempts；(status,availableAt)                                                                                  |

## 3. 初版可合并的关系

为避免空壳表，初版允许把 event_assets / project_assets / project_sources 放入经过 Zod 验证的 JSONB，并在聚合根上保留检索索引；event_evidence 与 event_sources 可通过持久化原始项关联共享一张 evidence 关系；AI run 与 usage 可在一个带不可变计费字段的运行表中表达；设置可使用带 namespace/ownerId 的 system_settings。是否合并必须在验收日志标明，不得丢失关联来源、版本或历史。后续迁移只增加结构并回填数据。

## 4. 事务与唯一性

原始项唯一键按来源外部 ID；无外部 ID 时用规范化载荷哈希。事件 fingerprint 包含链、资产/合约、动作类型、区块或交易标识，避免同标题不同资产合并。数据库 ON CONFLICT 实现幂等插入，不能只依赖预查询或 Redis SETNX。事件 + 项目/信号 + 规则触发 + 通知/outbox 同事务，checkpoint 在原始项持久化后才提交。通知工作进程用行锁或租约抢占，崩溃租约超时后可恢复。

## 5. 保留与归档

建议初始策略：原始数据 90 天在线后压缩归档；事件/信号/证据 2 年；高频指标 30 天明细后聚合；日志/健康/任务明细 30 天；审计与通知 1 年；Session 过期后每日清理。生产落地前按来源许可和磁盘容量确认，自动清理必须可配置且不得破坏仍被证据引用的原始记录。大表达到千万行或扫描影响 SLA 时使用月分区，并先通过备份恢复演练。

## 6. 迁移与备份

迁移文件纳入 Git，记录 checksum/执行时间，由单独 migration command 在应用启动前执行。可重复执行表示已执行文件跳过、并发受 advisory lock 保护，不允许重复 CREATE 无记录。生产只自动执行经审阅的增量兼容迁移；DROP/TRUNCATE/类型收缩须显式运维批准。部署前 pg_dump 自定义格式，备份路径权限 0700；回滚应用不回滚数据库，遵循 expand → compatible release → backfill → 后续独立 contract。验证包括从空库迁移、再次运行无变更、唯一约束、事务失败回滚和 pg_restore 抽样。
