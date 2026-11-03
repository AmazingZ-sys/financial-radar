# 16 · 运行与故障处理指南

设计日期：2026-11-02。命令以仓库最终 scripts 为准；实际验证结果写入实施记录。示例不包含生产凭据。

## 1. 开发与初始化

准备 Node LTS、pnpm、Docker/Compose。复制 `.env.example` 为 `.env`，设置管理员密码、会话与服务配置；启动开发 PostgreSQL/Redis，安装依赖、执行迁移和显式管理员初始化，然后分别启动 API、Worker、Web。完整入口命令由根 package scripts 提供。

Fixture 模式用于无第三方密钥的离线演练，界面和事件来源明确标记，禁止用它展示真实实时监控效果。live 模式只启用可访问且授权条件允许的数据源；未启用的源显示未配置，不能默认显示健康在线。

本地前端通过 Vite proxy 使用同源 API；生产部署需设置精确 WEB_ORIGIN/API 地址与 HTTPS Cookie。`.env`、数据库备份、Playwright 登录状态不得提交。

## 2. 健康与监控

- `/health`：进程存活与版本，不泄漏敏感配置。
- `/ready`：PostgreSQL、Redis 等必要依赖；故障返回非 2xx，不能因数据库不可用仍宣称就绪。
- 系统页：Worker 心跳、队列 waiting/active/failed、outbox 待投、数据源最后成功/新鲜度、AI 预算与失败、通知接口接受率。
- 记录发现、检测、队列、发送和端到端延迟；发布时钟未知的样本不混入延迟分位数。

日志检索使用 requestId→jobId→sourceId/eventId→notificationId 关联。不要复制带密钥的 URL 到 issue。默认开发日志易读，生产结构化 JSON。

建议告警：Worker 心跳超时 2–3 个周期、队列最老任务超过源 SLA、持续 429/5xx、通知重试耗尽、数据库连接失败、备份超期、磁盘空间不足。阈值可配置，日度宏观来源不使用秒级 freshness。

## 3. 常见故障

| 症状            | 检查顺序                                                    | 恢复                                          |
| --------------- | ----------------------------------------------------------- | --------------------------------------------- |
| 无新事件        | mode、源 enabled、lastSuccess、checkpoint、任务 backlog     | 修复配置或网络，再有限重试，保留 checkpoint   |
| 事件重复        | externalId/fingerprint、集群 identity、唯一约束、outbox key | 修复归一化并重放 raw，不能直接清库            |
| Redis 断开      | 网络、认证、内存与持久化、服务健康                          | 重启/修复 Redis，Worker 自动重连，outbox 补投 |
| PostgreSQL 断开 | 连接串、连接数、卷与磁盘、服务日志                          | 恢复数据库，重试队列；禁止删除卷              |
| AI 失败         | Provider 配置、配额、schema/evidence 错误                   | 规则预警继续；恢复后重试分析，不重复基础通知  |
| Telegram 失败   | configured/enabled、chat id、Bot 权限、429 与 retry-after   | 修复后重试失败任务；先查 attempt 避免重复     |
| 登录后反复 401  | Cookie Secure/SameSite、域名、时钟、CORS、session 到期      | 正确配置同注册域和 HTTPS，重新登录            |
| 写操作 403      | Origin、CSRF header、代理 Host/Proto                        | 修复代理/CORS，刷新会话，不关闭全部校验       |
| 发布后 502      | API readiness、镜像版本、迁移、Nginx upstream               | 健康检查，必要时回滚上一应用版本              |

外部数据源故障不切换到伪造实时值。切换备用 Provider 时保留来源名称与数据延迟差异，重新建立各自 checkpoint，不能假设游标兼容。

## 4. 备份、恢复与保留

每日 PostgreSQL 备份到受限目录，记录版本/时间/checksum；建议每日 7 份、每周 4 份和异地副本，具体按容量配置。备份后必须周期性在新数据库演练恢复并核对表计数、最近事件、规则和通知记录。Redis 持久化有助恢复队列，但业务事实仍以 PostgreSQL 为准。

恢复流程：停止 Worker 和写 API→保存事故现场→在新实例恢复→核对迁移版本与样本→切换连接→先启 API 再 Worker→检查 outbox 幂等与待重试消息→恢复流量。恢复数据库可能回到备份时刻，外部已发消息不能撤销，需要核对通知状态。

raw 默认保留 90 天，细粒度指标 180 天后聚合或归档，事件/证据/评分版本/审计按至少 1 年规划。删除任务先统计再分批执行；项目上生产前确认来源授权与实际存储成本。审计不应含密钥。

## 5. 发布、回滚与轮换

生产更新使用 `infra/scripts/deploy.sh --version vX.Y.Z`，不要直接拉 latest。执行前检查备份、变更日志与迁移兼容性。失败回滚使用 `rollback.sh`，只恢复应用镜像；数据库恢复按独立事故流程执行。Nginx 仅在 `nginx -t` 通过后平滑 reload。

轮换 AI key 或通知凭据：生成新 key→在系统管理/通知中心保存→显式测试→检查脱敏状态→撤销旧 key。后续 Worker 任务读取数据库中的加密覆盖配置，空白输入保留旧值；明确清除后不会回退环境密钥。尚未通过页面保存的配置继续使用服务器环境默认值，修改环境默认值仍需重启。轮换管理员密码后撤销现有会话。生产密钥不进入前端构建参数。

首次保存集成配置前，建议设置稳定的 `INTEGRATION_ENCRYPTION_KEY`，API 与 Worker 必须相同，至少32字符；为空时兼容使用 `SESSION_SECRET`。数据库备份包含密文，有效根密钥需独立安全备份。更换根密钥（包括从兼容回退切换到独立根密钥）会使旧密文无法解密，需要重新填写配置；不可先删除旧根密钥而未备份。新 RSS/Atom 订阅保存后由 Worker 自动同步注册与调度，最少60秒轮询，健康状态以实际请求结果为准。

## 6. 运维边界

外部 API 文档、商业授权和速率限制可能变化，定期复核 `docs/data-sources.md`；某一时刻只读联通成功不能证明持续 SLA。系统只提供信息与证据，不自动交易、不持有钱包密钥、不发起链上签名。新数据源、新通知渠道和新权限模型上线前，应补充对应测试与运维流程。
