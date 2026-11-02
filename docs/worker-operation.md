# Worker 操作与已验证边界

2026-11-02。Node 24 LTS；先启动 PostgreSQL/Redis，运行 `pnpm db:migrate`。

- `pnpm --filter @radar/worker once`：按已启用来源采集一次，处理持久 outbox，更新 DB+Redis 心跳；重复执行遵守 checkpoint 和唯一约束。
- `pnpm --filter @radar/worker dev`：BullMQ 长驻进程，15秒补投 outbox、更新心跳、同步 DB 数据源 enabled/interval；SIGTERM/SIGINT 排空当前任务后退出。
- `node apps/worker/dist/health.js`：读取 Redis `radar:worker:heartbeat`，缺失或超过90秒退出1。API 同时读 PostgreSQL `system_settings.worker:heartbeat`。

单队列 `financial-radar`，三类任务 INGEST / NOTIFY / ANALYZE。PostgreSQL outbox为持久事实，Redis丢队列后可按DB租约重新投递。source锁租约120秒；outbox租约2分钟；通知发送租约60秒。消息发送超时可能平台已接收，记录ambiguousAcceptance，SENT仅表示平台API接受。

Fixture默认不通过真实渠道发送，包括手动测试；通知状态CANCELLED，attempt为SIMULATED，不计为真实成功。Telegram/飞书/Bark已实现适配，真实密钥未提供所以生产发送仍待验收。

AI 缓存键包含事件证据、模型与promptVersion。每日预算通过 PostgreSQL advisory lock 原子预留 `AI_MAX_CALL_COST_USD`/次，最多3次调用；计费显示保守估算预留，非Provider真实账单。每次预留记录UTC时间，跨日预算重新计算；预算不足outbox延期到UTC次日，不丢事件。Provider无usage时token为null。失败有限重试，AI不阻止规则通知。

评分默认版本 `opportunity-v1/risk-v1`，机会未知输入记0，风险未知输入按0.5保守计算。`system_settings` key=`scoring-config` 可保存经 `ScoringConfigSchema` 校验的 `{opportunity:{version,weights},risk:{version,weights}}`。API管理入口由系统管理提供；修改只影响后续事件，已存明细保留原版本与权重，历史重算不自动发生。

当前通过：真实PostgreSQL/Redis Fixture纵向链路、二次幂等采集、AI Fixture证据校验、通知不外发、worker构建和心跳。真实Fed RSS、GitHub公开Release和Treasury日度数据采集通过；Coinbase当前网络超时；私有链RPC/UniSat/真实IM/真实LLM缺凭据未完成生产验证。API/Worker真实镜像、隔离生产Compose四服务、PG/Redis容器替换持久化与备份/新库恢复已通过，见 `acceptance.md`。目标生产服务器仍待部署验证。
