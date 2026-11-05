# Worker 操作与已验证边界

2026-11-02。Node 24 LTS；先启动 PostgreSQL/Redis，运行 `pnpm db:migrate`。

2026-11-05 更新：以 [候选优先分析](34-candidate-first-analysis.md) 为当前自动分析策略。线上急停可在「系统 → AI 集成」关闭 AI 并保存：已有 Worker 在下一次任务开始时读取配置，停止新付费请求；已经发送给供应商的请求可能仍完成并计费。现有部署不要仅删除环境 Key，因为数据库配置优先。新版本可在该面板设置“每日最多调用次数”（默认20、0暂停），保存后供后续请求读取。`AI_MAX_DAILY_CALLS`仅作为数据库尚未保存该字段时的初始默认，不能覆盖管理页已保存的值。旧版本须更新 API、Worker 和前端后使用。

- `pnpm --filter @radar/worker once`：按已启用来源采集一次，处理持久 outbox，更新 DB+Redis 心跳；重复执行遵守 checkpoint 和唯一约束。
- `pnpm --filter @radar/worker dev`：BullMQ 长驻进程，15秒补投 outbox、更新心跳、同步 DB 数据源 enabled/interval；SIGTERM/SIGINT 排空当前任务后退出。
- `node apps/worker/dist/health.js`：读取 Redis `radar:worker:heartbeat`，缺失或超过90秒退出1。API 同时读 PostgreSQL `system_settings.worker:heartbeat`。

采集/通知队列为 `financial-radar`（并发4），分析队列为 `financial-radar-ai`（并发2）；旧队列遗留 ANALYZE 转入分析队列后仍复查候选资格。PostgreSQL outbox为持久事实，Redis丢队列后可按DB租约重新投递。source锁租约120秒；通知 outbox 租约2分钟，分析15分钟；通知发送租约60秒。live 同时最多派发2个分析，通知独立优先派发。消息发送超时可能平台已接收，记录ambiguousAcceptance，SENT仅表示平台API接受。

Fixture默认不通过真实渠道发送，包括手动测试；通知状态CANCELLED，attempt为SIMULATED，不计为真实成功。Telegram/飞书/Bark已实现适配，真实密钥未提供所以生产发送仍待验收。

AI 缓存键包含事件证据、模型与promptVersion。每日预算通过 PostgreSQL advisory lock 原子预留 `AI_MAX_CALL_COST_USD`/次，单个缓存最多尝试3次；live 每天最多管理页保存的 `maxDailyCalls`（默认20）次真实调用，重试也计次。计费显示保守估算预留，非Provider真实账单。每次预留记录UTC时间，跨日预算重新计算；预算不足的候选以 SKIPPED 结束，保留事件与原因，不延期到次日。Provider无usage时token为null。失败有限重试，AI不阻止规则通知。

新 Worker 每次派发前分批检查最多500个遗留事件，不符合策略的 outbox 结束为 COMPLETED，事件显示 SKIPPED；已完成解读和运行中请求受保护。Redis 中旧任务仍可能短暂显示排队，消费时会跳过而不调用模型；不以清空 Redis 或删除事实处理积压。新事件候选最多20条，同资产冷却6小时，一小时后过期。规则新增「通知常规变化」默认关闭，抑制新的通用新池/mint 提醒；已持久化的通知不会被伪造为撤销或已读。

评分默认版本 `opportunity-v1/risk-v1`，机会未知输入记0，风险未知输入按0.5保守计算。`system_settings` key=`scoring-config` 可保存经 `ScoringConfigSchema` 校验的 `{opportunity:{version,weights},risk:{version,weights}}`。API管理入口由系统管理提供；修改只影响后续事件，已存明细保留原版本与权重，历史重算不自动发生。

当前通过：真实PostgreSQL/Redis Fixture纵向链路、二次幂等采集、AI Fixture证据校验、通知不外发、worker构建和心跳。真实Fed RSS、GitHub公开Release和Treasury日度数据采集通过；Coinbase当前网络超时；私有链RPC/UniSat/真实IM/真实LLM缺凭据未完成生产验证。API/Worker真实镜像、隔离生产Compose四服务、PG/Redis容器替换持久化与备份/新库恢复已通过，见 `acceptance.md`。目标生产服务器仍待部署验证。

## X 免费自建采集

采集频率使用管理页的最短/最长秒数，默认600–1200秒。真实请求前在数据库锁内随机预留下次时间；该时间跨重启、Redis丢失、配置保存继续有效。X不使用固定周期scheduler，协调器投递可恢复的单次延迟任务；遗留任务和手动测试均在实际请求前复查同一门禁。限流按随机等待与平台冷却的较晚时间执行，缺少有效429冷却时至少暂停15分钟。区间控制本地采集任务调用，单次任务可能读取多个网页响应，不保证避免账号限制。旧单值配置按原值到1.5倍（上限86400秒）兼容读取，不原地改写证据或配置。详见 [37 随机采集](37-x-random-polling.md)。

当前方案见 [36 免费X采集](36-free-x-collection.md) 与 [采集器部署](../services/x-collector/README.md)。X采集不调用官方或第三方付费数据API，不使用付费AI抽取原文；已有服务器的资源消耗另计。

生产Compose提供可选`x-free` profile，采集器只在内部8080端口服务。API、Worker和采集器设置相同`X_COLLECTOR_SECRET`（至少32字符）；API/Worker的`X_COLLECTOR_URL=http://x-collector:8080`。新增这些环境配置后需重建对应容器；随后管理页的X登录态、关注账号、间隔、上限可热更新。开发Compose仅映射`127.0.0.1:18080`，本地API/Worker使用该回环地址。

系统管理的X面板维护自己的授权会话`auth_token`与`ct0`，只加密存数据库、不回显、不放入链接或聊天。先保持关闭，保存并测试，成功后启用。Fixture不会请求采集器。测试/失败同样计入本地每日请求数，这个上限控制负载，不是账单。

来源出现登录失效时更新登录态；限流按冷却时间暂停。采集器不可达、限流或结构错误不代表“没有热点”，不会切到付费服务。原帖仅保存证据，不发通用通知、不逐条调用AI；满足多作者原创门槛的讨论候选才受AI全局预算分析，完成后按P2/P3规则产生研究提醒。通知阶段失败不会回滚已付费的AI完成结果，重放只恢复通知。
