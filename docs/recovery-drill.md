# 真实故障恢复演练记录

执行日期：2026-11-02（Asia/Shanghai）。脚本 `apps/worker/scripts/recovery.ts`；命令 `pnpm --filter @radar/worker recovery`；Node 24.15.0。最近完整机器可读输出位于运行机 `.local/recovery-latest.json`，不提交临时数据库与凭据。

## 隔离方式

新建临时 PostgreSQL 18.6 与 Redis 7.4.2 实际进程，随机回环端口。本次 PostgreSQL 56337、Redis 56338；没有停止现有开发5432/6379。导入 config/数据库/API 模块之前注入隔离环境URL，使用正式迁移、正式Worker和Hono API。结束关闭全部测试进程并移除临时目录。

## 实际通过的检查

| 检查             | 操作与观察                                                                                                                                | 结果 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 初始纵向链路     | 一次Fixture采集：raw5、events5、projects4、signals4                                                                                       | 通过 |
| Redis 停止       | 停止真实Redis进程，API /ready返回503                                                                                                      | 通过 |
| Redis 恢复       | 同一端口重新启动，API /ready恢复200，PG事实计数不变                                                                                       | 通过 |
| PostgreSQL 停止  | 停止真实PG进程，API /ready返回503                                                                                                         | 通过 |
| PostgreSQL 恢复  | 使用同一数据目录重新启动，API /ready恢复200，raw/event/project/signal/notification计数全部保持                                            | 通过 |
| Worker 异常退出  | 启动正式长驻Worker，确认其PID心跳后SIGKILL，再启动one-shot恢复                                                                            | 通过 |
| 过期租约与幂等   | 构造SENDING通知、QUEUED outbox过期租约，再执行正式恢复；通知CANCELLED/SIMULATED不外发，attempt增加，事实与通知数量不增加，dedup_key无重复 | 通过 |
| 远端限流持久冷却 | DB记录一小时cooldownUntil后调用采集，返回skipped；计数器证明connector.fetch未调用                                                         | 通过 |

22个基础单测及链适配器6个RPC契约测试另验证：未知评分不当满分、风险不能被机会覆盖、无未来证据泄漏、错误合约不聚合、远端429不提前重试、JSON证据ID/链接校验、Fixture真实渠道防外发、finality/重组/分页缺口。后续新增测试数量以 `pnpm test` 实际输出为准。

## 不能从本次演练推断的结论

- 本节记录真实本地进程恢复。后续另完成隔离生产Docker Compose、PG/Redis容器替换持久化和真实备份/新库恢复，见 `acceptance.md`；生产宿主机Nginx、GHCR发布或目标服务器回滚仍未运行验收。
- 未提供真实IM/LLM/链索引器生产密钥，未验证第三方实际送达、计费、授权额度或全天候SLA。
- SIGKILL发生于Worker建立心跳之后；SENDING租约超时通过数据库构造，未精确打断在“平台已接受但DB尚未commit”的毫秒窗口。Telegram不支持本系统业务幂等键，响应丢失仍可能重复发送，attempt记录该不确定性。
- 本次保留同一Redis持久目录；Redis全数据永久丢失的队列补投由PostgreSQL outbox设计和集成测试覆盖，不能把这一项声称为本脚本实测完成。
- AI不可用时的确定性预警与预算边界由对应集成/单测覆盖；此脚本没有伪造真实LLM停机事件。
