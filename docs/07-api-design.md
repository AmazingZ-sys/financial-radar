# 07 · API 设计

设计版本：1.0 · 2026-11-02。

## 1. 公共协议

API 前缀 `/api/v1`；JSON；服务端 UTC ISO-8601 时间。Zod 定义输入与输出，Hono OpenAPI 路由导出 `/openapi.json`，Web 通过生成命令同步类型。文档路径与实际路由需通过测试对照。

成功列表：`{data: T[], meta: {total: number, page: number, pageSize: number, asOf: string, dataMode: "fixture"|"live"}}`。详情为 `{data: 领域 DTO}`，包含证据、时间与 dataMode。统一错误：`{error: {code, message, requestId, details?}}`；Zod 错误不泄露内部路径或配置。HTTP 400 验证失败、401 未登录、403 权限/CSRF、404 不存在、409 冲突、429 限流、503 依赖未就绪、500 内部错误。

分页 page>=1，pageSize 1..100；未知参数拒绝或明确忽略，不拼 SQL。过滤值均经枚举/长度/日期校验。客户端 Query key 包含筛选条件，变更后 invalidate 相关列表。

## 2. 认证

`POST /api/v1/auth/login {email,password}` 使用 scrypt 校验；成功设置随机 256-bit Session cookie，数据库只保存 hash 与有效期。Cookie HttpOnly、生产 Secure、SameSite=Lax（同站部署）或明确的跨站部署策略。`GET /api/v1/auth/me` 返回无密钥用户与 CSRF token；`POST /api/v1/auth/logout` 删除 Session。写请求必须 Origin allowlist + CSRF（或等价双重提交），Vercel 前端与 API 分离 Origin 时明确设置 credentials、具体 allow-origin 和 CSRF，不能 `*`。生产使用 `radar.amazingzsys.site` 与 `api.radar.amazingzsys.site` 同站子域，迁移托管不改变此契约；临时 `vercel.app` 地址不加入生产允许名单。

## 3. 路由契约

| 方法与路径                               | 用途 / 输入                                                          |
| ---------------------------------------- | -------------------------------------------------------------------- |
| GET /health                              | 进程存活，无敏感配置                                                 |
| GET /ready                               | PG 与 Redis 就绪，未就绪 503                                         |
| GET /openapi.json                        | OpenAPI 契约，可配置需鉴权                                           |
| GET /api/v1/system/status                | 版本、模式、Worker 心跳、队列数量、密钥配置布尔值、AI 用量、延迟统计 |
| GET /api/v1/dashboard                    | 今日 UTC 或设置时区边界统计、最近事件/项目/告警，必须显式 asOf       |
| GET /api/v1/events                       | q、category、asset、priority、from/to、page/pageSize                 |
| GET /api/v1/events/:id                   | 事件详情、分析状态及证据                                             |
| GET /api/v1/events/:id/sources           | 来源、原始发布时间、采集时间、原始记录引用                           |
| GET /api/v1/projects                     | chain、stage、verified、risk、q、page/pageSize                       |
| GET /api/v1/projects/:id                 | 项目、发现时与最新指标、评分分解、参与条件                           |
| GET /api/v1/projects/:id/timeline        | 阶段、指标、信号、风险历史                                           |
| GET /api/v1/projects/:id/signals         | 独立信号列表                                                         |
| GET /api/v1/alerts                       | 规则触发与原因、关联事件                                             |
| GET /api/v1/alert-rules                  | 管理员的规则列表                                                     |
| POST /api/v1/alert-rules                 | 规则 Create Schema，ownerId 来自 Session                             |
| PATCH /api/v1/alert-rules/:id            | 部分更新、版本+1并存快照                                             |
| DELETE /api/v1/alert-rules/:id           | 软删除或禁用且保留触发历史                                           |
| POST /api/v1/alert-rules/test            | 给定事件/项目快照返回命中与原因，不发送通知                          |
| GET /api/v1/sources                      | metadata、enabled、健康、新鲜度、延迟、下次轮询                      |
| GET /api/v1/sources/:id                  | 公开配置与能力，密钥仅 configured                                    |
| PATCH /api/v1/sources/:id                | enable/interval 范围，不能客户端提交任意 URL/密钥                    |
| GET /api/v1/sources/:id/health           | 分页健康与采集历史                                                   |
| GET /api/v1/notifications                | 状态、平台接受时间、attempts，绝不声称已阅读                         |
| GET /api/v1/notification-channels        | 可用 provider 与配置状态                                             |
| PATCH /api/v1/notification-channels/:id  | enabled / public preferences                                         |
| POST /api/v1/notification-channels/test  | channelId；明确手动测试，单独限流并审计                              |
| POST /api/v1/notifications/:id/retry     | FAILED 通知重试，不克隆重复记录                                      |
| GET /api/v1/markets/assets               | 最新可得行情、source/asOf/unit/delay/dataMode                        |
| GET /api/v1/markets/history              | asset、from/to；观测序列及来源，禁止插值装作真实采样                 |
| GET/PATCH /api/v1/settings               | 当前用户时区、主题与通知偏好                                         |
| GET/POST /api/v1/watchlists              | 观察列表管理                                                         |
| POST/DELETE /api/v1/watchlists/:id/items | 资产键受 Schema 验证                                                 |
| POST /api/v1/replay                      | 仅提供存储/Fixture 区间与 scoringVersion；结果不表示收益回测         |

## 4. 安全边界

除 health、ready、登录及必要契约端点外均需登录。修改操作审计 actor/requestId/对象，不保存密码或 Token。管理员不能通过测试渠道接口随意发送到其他用户收件箱。接口外部依赖耗时任务返回 202 + job/reference；HTTP 请求不等待 AI。响应 Zod 校验可在测试或统一响应层强制，校验失败 500 并仅记录字段错误。
