# Financial Radar 工程约定

- 先阅读 docs/00-project-overview.md 和 docs/17-implementation-plan.md；设计文件先于业务实现。
- 固定技术栈见需求：Vue 3 / Hono / Drizzle PostgreSQL / Redis BullMQ；pnpm workspace，Node 24 LTS。
- TypeScript strict；数据 DTO 用 Zod；禁止 eval；UTC + UUID；数据源时间与发现时间分开。
- 永远显式区分 live/fixture；不得伪造行情、链上数据、来源、回测、用户已读状态。
- 机会评分和风险独立；严重风险不可被机会分抵消；AI 不阻塞确定性告警。
- 密钥只在服务器环境；日志脱敏；禁止真密钥提交；浏览器不得保存第三方密钥。
- 事实存 PostgreSQL；Redis 可恢复；写入幂等；数据库迁移向前兼容，禁止自动删卷/破坏性 DDL。
- API 列表 envelope: { data: [], meta: {total,page,pageSize,dataMode,asOf} }；错误 {error:{code,message,requestId}}。
- Auth /api/v1/auth/login, /me, /logout；HttpOnly session；me返回csrfToken，写请求X-CSRF-Token。
- 外部访问需超时和限流；通知SENT只表示平台接受，不能声称用户已读。
- 变更后运行 typecheck、lint、test、build 与相关集成测试；结果记录 docs/acceptance.md。
- Conventional Commits，分支 codex/ 前缀；发布凭据与生产操作需要实际配置，不能伪报发布成功。
