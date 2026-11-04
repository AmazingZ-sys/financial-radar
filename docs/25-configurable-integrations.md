# 25 可配置 AI、通知与多领域新闻源

设计日期：2026-11-03。目标：管理员通过控制台管理 AI 中转站、通知凭据与新闻订阅，修改后由运行中的 Worker 读取；环境变量保留为兼容默认值。

## 配置与安全边界

- AI 支持 OpenAI-compatible Chat Completions 协议：可编辑名称、Base URL、模型、API Key、启用状态、超时、JSON 模式与预算。Base URL 是 API 根路径（通常以 /v1 结尾）；配置兼容中转服务不代表支持任意私有协议。
- 配置事实存 PostgreSQL；凭据仅写入服务器端加密存储。加密根密钥来自服务器环境，浏览器输入只用于当前提交，不进 localStorage/sessionStorage，不回显密钥。GET 仅返回是否已配置；空白保留、显式清除动作删除。审计仅记录字段名和状态，不记录密钥或带凭据的 URL。
- 保留现有环境变量作为默认值；页面明确显示环境默认/数据库覆盖。Worker 每次任务读取有效配置，无需重启即可用于后续任务。运行模式 live/fixture 仍由部署环境控制。
- 外部请求必须有超时、限流、响应体上限，禁止重定向泄漏凭据。动态 URL 仅允许公开 HTTPS，拒绝用户信息、私网/保留地址及 DNS 解析后的私网地址；防止 DNS 重绑定。
- AI 测试需要管理员明确点击；Fixture 模式不进行真实 AI/通知调用。配置不会使 AI 阻塞确定性告警；缓存区分提供商配置，预算限制继续生效。

## 接口契约与页面

- GET/PATCH /api/v1/integrations/ai：配置视图与写入；POST /api/v1/integrations/ai/test：显式连接/模型协议测试，返回真实测试状态。所有写入沿用 session、Origin、CSRF 和审计。
- GET /api/v1/notification-channels：返回原有渠道及安全配置状态；PATCH /api/v1/notification-channels/{id}：扩展名称、启用和对应 provider 凭据；现有测试接口保留。支持 Telegram Bot Token + Chat ID、飞书 Webhook、Bark 完整推送地址，以及自定义 SMTP 邮箱（主机、端口、TLS/STARTTLS、可选认证、发件人与收件人）。SMTP 密码只存服务器端加密字段，GET 只返回已配置状态；测试邮件沿用 live/fixture 隔离和通知审计。
- GET /api/v1/sources/catalog：已实现来源目录与分类；POST /api/v1/sources：添加管理员授权的 RSS/Atom 公共订阅；现有 PATCH 调整启停与轮询。订阅 URL 不原地替换，避免旧证据来源混淆。
- 系统管理提供 AI 配置表单；通知页面提供渠道配置；数据源页面提供分类、来源目录与新增 RSS/Atom。使用现有 Vue 控制台视觉体系，并明确保存、测试、失败与待配置状态。

## 多领域数据源

- 保留 Fed 政策公告、美国财政部日度利率等现有非加密数据源，增加经官方资料确认的综合/财经/科技/政策 RSS 来源。具体端点与使用限制由实现时的官方核验补充。
- 数据源目录与已启用列表分开，Fixture 页面也可查看可接入的 live 来源，但不得将真实新闻混入 Fixture 处理链。
- RSS/Atom 保存来源标识、原始条目、原标题/摘要/链接、来源发布时间（缺失为 null）、首次发现时间。未知作者可信度不得自动升级为 VERIFIED；新闻事件进入已有热点/规则链。
- XML 禁用 DTD/实体；限制响应大小、条目数与字段长度；只取摘要，不自动抓取全文；按 URL/条目 ID 幂等入库。最小轮询 60 秒，失败保留最后状态。自定义订阅经数据库同步到注册表与队列。

## 验收

验证鉴权/CSRF、凭据不回显不落日志、加密往返/篡改失败、清除与环境默认语义、配置热更新、AI 中转请求与缓存隔离、通知真实配置读取（含 SMTP TLS/STARTTLS、超时和收件人校验）、RSS/Atom 解析/幂等/缺失时间/错误/SSRF、来源分类与表单。执行 typecheck、lint、test、build 和相关 PostgreSQL/Redis 集成测试，结果记入 docs/acceptance.md。生产部署须另行执行，不以本地验证冒充线上生效。
