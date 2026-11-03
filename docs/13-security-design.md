# 13 · 安全设计

设计日期：2026-11-02。首版为单管理员，所有业务数据按 ownerId 或预留租户边界组织。部署前须修改示例凭据。

## 1. 认证、会话与授权

管理员密码使用 Node crypto scrypt 和随机盐派生，比较使用 timingSafeEqual。数据库仅保存密码派生值；不保存明文或可解密密码。管理员初始化命令必须显式读取环境变量，不在构建阶段创建生产账户。

登录成功后生成至少 256 bit 随机会话令牌，仅令牌摘要存 PostgreSQL。Cookie 设置 HttpOnly、Path=/、SameSite=Lax、生产 Secure；有效期与服务器过期检查一致。退出、密码轮换和管理员禁用可撤销会话。生产部署前端与 API 应使用同一注册域，例如 app.example.com 与 api.example.com；跨站部署必须显式调整 SameSite=None; Secure，并承认第三方 Cookie 可能被浏览器阻止。

除 `/health`、`/ready`、登录及受控的 OpenAPI 外，业务接口均执行认证。权限在服务端判断，隐藏前端按钮不构成权限控制。用户不能通过修改路径参数访问其他 ownerId 的配置。首版 admin 角色为唯一可管理角色，不开放自助注册。

Cookie 鉴权写请求要求 Origin 位于精确允许名单，同时验证与会话关联的 CSRF token，客户端通过 `X-CSRF-Token` 提交。读取接口不可产生业务写入。CORS 不使用通配符配合 credentials。不信任任意代理头；仅在明确代理部署配置下读取可信转发 IP。

## 2. 输入、输出与限流

Zod 对路径、查询和 JSON body 进行验证，拒绝未知字段或在契约层明确剔除；分页上限 100，搜索长度和请求体大小受限。Drizzle 参数化查询，规则是结构化 JSON，不允许 eval、Function 或动态 SQL。

登录按可信客户端 IP 和账号进行限流，错误不泄漏账号存在与否。写操作、通知测试与回放执行独立限流；限流存 Redis，失败策略按接口区分：登录和敏感写操作返回 503，健康检查不依赖 Redis 限流。统一响应不包含堆栈、SQL、私密 URL 或 token。

前端不使用 v-html 渲染外部新闻或 AI 内容。来源链接只允许 http/https，外链使用 noopener/noreferrer。AI 输出是未信任数据，必须 Schema 校验；不执行模型生成的脚本、SQL、工具调用、交易或链上签名。

## 3. 出站访问和 SSRF

Connector 地址来自服务器端静态注册表或受管理员审计的允许名单，普通 API 不接受任意抓取 URL。通知渠道 URL 限定官方协议与主机；Webhook URL 若开放配置，需屏蔽本地、内网、link-local、云元数据地址与重定向绕过。响应体、重定向次数与超时有上限。HTTP 重试不能无限占用 Worker。

RSS XML 解析不解析外部实体。日志不得记录完整抓取请求 URL，因为 query/path 可能含 API key。任何新 Connector 必须声明密钥字段与可记录字段。

## 4. 密钥与审计

数据库、Redis、集成加密根密钥通过服务器环境或密钥挂载注入。AI 与通知凭据可由管理员通过 HTTPS/Session/CSRF 提交，加密存入 PostgreSQL；浏览器仅暂存当前输入，提交、关闭或卸载时清空，不落 localStorage/sessionStorage 或查询缓存。环境中的第三方凭据是初始默认，覆盖配置与明确清除的语义见 [25 可配置集成](25-configurable-integrations.md)。浏览器环境变量限定 VITE_API_BASE_URL 和公开构建元数据；不得设置 VITE_* 私密 key。普通接口只返回配置状态及公开字段，不回显第三方密钥或带设备 Key 的 URL。

日志记录 requestId、jobId、eventId、sourceId 和结果，不记录 Authorization、Cookie、密码、完整 Bot URL。结构化 logger 在对象键和错误文本两层脱敏。Fixture 不含真实凭据。`.env`、备份、日志与认证状态文件必须进入 .gitignore。

审计覆盖登录失败/成功、规则变更、渠道变更、来源启停、设置修改、回放执行与人工核验；记录操作者、时间、实体、变更摘要与 requestId。密钥变化只记录是否改变，不能记录值。

第三方密钥轮换顺序：创建新凭据→控制台保存→测试→撤销旧凭据→检查失败队列；环境默认配置修改仍需重启。集成加密根密钥由 API/Worker 共享并独立备份，更换有效根密钥后需重新填写集成凭据。会话撤销以数据库 Session 为准，不能只轮换 SESSION_SECRET。

## 5. 运行环境

容器使用非 root 用户、只读文件系统及必要 tmpfs、cap_drop ALL、no-new-privileges，数据库与 Redis 仅在 Compose 内网。API 仅绑定宿主机 loopback。Nginx 强制 HTTPS，添加 nosniff、Referrer-Policy 和受控 CSP；HSTS 应在域名 HTTPS 验证后启用。

备份按敏感资产处理，限制文件权限并建议独立加密与异地存储。迁移默认只允许经审查的向前兼容变更。依赖检查与 secret 扫描是 CI 门禁，扫描通过不意味着不存在漏洞。

## 6. 资金边界与验收

系统没有钱包私钥、助记词、交易所交易权限、自动交易或签名接口。项目参与链接只有已验证来源才可提供，未知链接仅作证据参考并提示风险。机会评分不能消除风险提示。

安全测试至少覆盖：未登录 401、跨 owner 拒绝、缺少/错误 CSRF 403、错误 Origin 403、登录限流 429、超长查询 400、XSS 文本安全渲染、通知重复发送保护、接口/日志无密钥、生产配置拒绝默认凭据。对外生产发布仍需要真实域名/证书/服务器权限及部署验收。

## 管理员凭据轮换与人工复核实现补充

新增管理员重置命令通过服务器环境读取ADMIN_PASSWORD，使用scrypt重新散列并撤销该管理员全部会话，记录审计；不接受命令行明文密码，不打印哈希或密钥。生产默认凭据由配置层拒绝。SESSION_SECRET轮换本身不替代数据库随机session撤销。

AI人工复核只改变分析的reviewStatus/人工备注，不能把待验证项目、来源、合约安全或参与条件提升为已验证事实。复核要求管理员+CSRF+Origin，保存reviewerId/reviewedAt/note并审计，APPROVED仅表示管理员确认该分析可供研究。
