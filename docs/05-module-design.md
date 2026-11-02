# 05 · 模块设计与依赖

设计版本：1.0 · 2026-11-02。

| 模块                   | 职责                                               | 可以依赖                                     |
| ---------------------- | -------------------------------------------------- | -------------------------------------------- |
| apps/web               | 页面、路由、Pinia 偏好、Vue Query、统一 API Client | shared / 生成的 OpenAPI 类型                 |
| apps/api               | Hono 路由、Session、CSRF/Origin、验证、服务编排    | 各服务包，不直接做周期采集                   |
| apps/worker            | 采集、处理、AI、通知、补投、健康心跳               | connectors/signals/database/ai/notifications |
| packages/shared        | Zod 输入输出 DTO、枚举、错误码、领域类型           | zod，不依赖数据库/应用                       |
| packages/config        | 环境变量读取、配置 Schema、生产必填门禁            | shared                                       |
| packages/database      | Drizzle Schema、迁移、仓库、事务                   | shared/config                                |
| packages/connectors    | Pull/Stream/Webhook 接口、注册、超时与来源协议转换 | shared/observability                         |
| packages/signals       | 纯函数去重、分类、评分、规则、生命周期、回放       | shared                                       |
| packages/ai            | Provider、Prompt、结构化验证、证据约束、预算       | shared/config                                |
| packages/notifications | 模板、Provider、平台响应分类                       | shared/config                                |
| packages/observability | 结构化日志、敏感字段脱敏、时间/关联 ID             | 无领域业务依赖                               |

## 1. Controller / Service / Repository

Controller 仅处理鉴权、输入解析、调用 Service、输出校验。Service 决定事务和业务权限。Repository 封装 SQL 与幂等操作。纯算法不得依赖网络、系统时钟或数据库；显式传入 `now`、权重版本和证据快照，便于测试与回放。

## 2. Connector 契约

每个 Connector 定义：`id`、`metadata`（文档/来源/更新频率/延迟/是否需要密钥/fixture 标记）、`capabilities`、`rateLimitPolicy`、`retryPolicy`、`initialize()`、`fetch(cursor)` 或 `subscribe(callback)`、`normalize(raw)`、`healthCheck()`、`shutdown()`。fetch 返回原始项目和候选 nextCursor。错误分类：TRANSIENT、RATE_LIMIT、AUTH、PERMANENT、SCHEMA。Registry 使用服务端明确注册表，不能根据前端字符串动态 require 或访问任意 URL。

## 3. 信号与数据结构

- Event：时间语义、资产/分类、来源关联、置信度、严重程度、验证/分析状态。
- Project：阶段、独立风险与观察属性、资产标识、参与条件与时间窗口、发现时指标。
- OpportunitySignal：类型、证据、检测时间、输入指标及分数版本。
- Rule：可验证声明式条件，不允许 JavaScript、SQL、eval 或任意模板执行。
- Notification：规则版本 + 事件/信号 + 渠道 + 冷却窗口唯一键，状态流转独立。
- AIResult：仅对可用 evidenceIds 引用事实；解释与推断必须区别。

## 4. 任务契约

队列按 ingestion、analysis、notifications 分离；任务载荷只包含数据库 ID、关联 ID 和版本，不复制密钥或大量正文。稳定 jobId 使用安全哈希，避免 ID 分隔符兼容问题。重试次数、超时与退避可配置，超过次数保留失败记录；不因 Redis 清队列删除业务事实。通过锁防止同来源重叠采集；锁有 TTL 和续期，数据库唯一约束为最终并发保护。
