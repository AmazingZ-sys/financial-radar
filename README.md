# Financial Radar · 金融雷达

面向早期金融与链上信号的研究工作台。保存“当时看到了什么”的原始证据，分别计算机会和风险，依照可解释规则预警。**默认运行明确标记的 Fixture 模式**，不把合成项目、未知行情或日度数据描述成实时投资机会。

生产域名配置：前端 `https://radar.amazingzsys.site`，API `https://api.radar.amazingzsys.site/api/v1`。前端 v1.1.1 已发布至 [Vercel](https://financial-radar.vercel.app)，Actions 与静态部署验收通过；正式域名 DNS 已由用户切换并验证，项目配置及迁移记录见 [发布说明](docs/23-release-and-update.md)。Ubuntu 22.04/24.04 服务器首次安装、DNS、HTTPS、生产配置与更新步骤见 [实际域名部署指南](docs/24-server-api-radar-amazingzsys-site.md)。

已经运行的服务器升级到本轮 AI/通知可配置与多领域新闻版本，见 [v1.1.0 更新步骤](docs/27-v1.1-server-update.md)。

本项目按文档先行要求实施：[需求](docs/01-requirements.md) → [架构](docs/04-system-architecture.md) → [实施计划](docs/17-implementation-plan.md) → [验收证据](docs/acceptance.md)。用户附件原文保存在 [docs/user-request.md](docs/user-request.md)；原文末尾截断于文档列表的 `docs/18-risk`。

## 当前能力

- 中文 Vue 3 终端：总览、事件与原始证据、早期机会与项目时间线/指标、行情、经济日历、规则、通知、数据源、系统/观察列表。深浅主题和移动导航。
- Hono API：管理员 scrypt 登录、数据库 Session、CSRF/Origin 校验、权限/限流、Zod 输入与输出、自动 OpenAPI、分页/筛选、审计。
- 真实 PostgreSQL 事实库与 Drizzle Schema/版本迁移；Redis/BullMQ 调度、共享限流与租约；事务 outbox、任务补投与持久化 checkpoint。
- 官方 RSS、配置的协议 GitHub Release 白名单、Coinbase 市场接口、UniSat BRC-20 有界状态采样、管理员配置的已知资产 DEX 跟踪；限定 EVM Factory 与 Solana Program 的 finalized 链上适配器。准确范围及授权见 [数据源调研](docs/03-data-sources.md)。
- 资产身份去重、相似文本聚合、项目阶段、独立机会/风险评分及权重版本、历史指标差分信号、已核验参与窗口时钟告警、规则冷却/静默时段、按可知时间回放。
- AI Provider 抽象、结构/证据验证、预算预留、缓存、重试/降级、人工复核；每日摘要接口只汇总已存事实与已有分析，不等待同步 AI。
- Telegram、飞书、Bark 统一渠道，持久化尝试和失败重试。`SENT` 表示平台接受；Fixture 处理记录为模拟取消，绝不发送真实通知。
- GHCR/semantic-release/Vercel 工作流，独立 API/Worker 镜像、生产 Compose、宿主机 Nginx、备份/恢复/更新/回滚脚本。

真实 Telegram/LLM/付费数据仍需凭据与授权，不能把本地测试视为这些外部服务已开通。前端发布和自动更新说明见 [自动发布与服务器更新](docs/23-release-and-update.md)。全链无遗漏扫描、付费黄金/原油实时数据、真实 ORDI 历史收益回测也不是本次验证结论；逐项边界见 [风险与依赖](docs/18-risks-and-dependencies.md)。

## 本地启动

需要 Node.js 24 LTS、pnpm 10.26.2。依赖版本锁定在 pnpm-lock.yaml。

```bash
nvm use
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

启动 PostgreSQL/Redis，任选一种方式：

```bash
# 有 Docker daemon
 docker compose -f docker-compose.dev.yml up -d --wait

# 无 Docker daemon：启动真实本地进程，数据保留在 .local，Ctrl-C 停止
pnpm services:local
```

在另一个终端执行：

```bash
pnpm db:migrate
pnpm --filter @radar/worker once
pnpm dev
```

打开 [http://localhost:5173](http://localhost:5173)。本地默认管理员：`admin@radar.local` / `change-me-local-only`。这些默认值仅用于本地；生产配置层会拒绝默认密码和不安全 Cookie。`WEB_ORIGIN` 必须与浏览器实际地址一致；若使用 127.0.0.1 或自定义端口，需要一并修改 Origin。

`.env.example` 的 DATABASE_URL/REDIS_URL 指向本地开发服务；生产必须改成 Compose 内的 `postgres` / `redis` 主机名和匹配的安全凭据，不能原样复制作为生产配置。详见 [部署手册](docs/20-deployment-runbook.md)。

## 模式与第三方配置

- `DATA_MODE=fixture`：合成链上项目、宏观测试事件和日历通过真实数据库处理链；无实际链上参与地址，无真实行情时显示未知。
- `DATA_MODE=live`：启用真实且已配置的适配器。无凭据/无范围的数据源显示未配置。不会用 Fixture 回填失败的真实来源。
- `GITHUB_REPOSITORIES`：逗号分隔的协议官方仓库白名单；仓库所有权须人工确认。
- `DEX_CHAIN` + `DEX_TOKEN_ADDRESSES`：仅跟踪最多30个已知 token；空地址列表为未配置，不代表新币全量发现。
- UniSat：`UNISAT_API_KEY`。EVM：`EVM_RPC_URL` + 已核验 `EVM_FACTORY_ADDRESS`；Solana：`SOLANA_RPC_URL` + `SOLANA_PROGRAM_ID`。范围型监控不能解释为全链覆盖。
- Telegram：`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`。飞书：官方 `FEISHU_WEBHOOK_URL`。Bark：完整 HTTPS 设备推送 `BARK_SERVER_URL`。
- AI：在「系统管理 → AI 服务配置」填写 OpenAI-compatible 服务或中转站的 API 根地址（例如 `https://relay.example/v1`）、模型、API Key、超时、JSON 模式和预算。`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL` 等环境变量保留为初始默认值；页面保存后覆盖，后续 Worker 任务直接读取，无需重启。成本为保守预算预留/估算，不能替代供应商账单；未配置时规则链继续工作。
- FRED 因已发现的 AI/存储条款冲突默认不接入；Coinbase 等许可按私有研究范围审查，公开再分发前须确认授权。具体官方链接均在数据源文档中。

「通知中心」支持保存 Telegram、飞书、Bark 的渠道凭据与启停；「数据源」展示宏观政策、财经市场、科技动态、全球热点与加密资产分类及来源目录，并支持新增已获授权的公开 HTTPS RSS/Atom 订阅。新闻保存标题、摘要、来源和实际发布时间，不抓取付费全文。Fixture 可查看 Live 目录，但不采集真实订阅、不实际调用 AI 或发送通知；启用真实采集需在服务器设置 `DATA_MODE=live`。

密钥在页面中只用于当前提交，不存入浏览器持久存储，接口只返回是否已配置。凭据加密存储在 PostgreSQL，`INTEGRATION_ENCRYPTION_KEY` 是 API/Worker 共享的服务器加密根密钥（至少32字符）；为空时兼容使用 `SESSION_SECRET`。请在首次保存前配置稳定根密钥，并与数据库备份分别妥善保存。更改有效根密钥后需重新填写集成凭据。空白密钥保留旧值，「清除凭据」明确清除；清除后不自动恢复环境变量中的密钥。

动态地址须为公开 HTTPS，拒绝私网、凭据 userinfo 和重定向；AI Base URL 不应携带查询密钥。前端仅设置公开的 `VITE_API_BASE_URL`（生产值为 `https://api.radar.amazingzsys.site/api/v1`，本地开发为 `/api/v1`）。后端生产 `WEB_ORIGIN=https://radar.amazingzsys.site`，`COOKIE_SAME_SITE=Lax`、`SECURE_COOKIE=true`。配置契约与安全边界见 [配置设计](docs/25-configurable-integrations.md)。

## 开发与验证

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
# 必须连接独立或本地非生产 Fixture 数据库；会写测试规则/审计/模拟通知
pnpm test:integration
# 隔离随机端口的真实 PG/Redis 故障恢复演练，需要本地编译 Redis 的 make 工具
pnpm --filter @radar/worker recovery
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
pnpm security:check
pnpm audit --prod --audit-level moderate
pnpm api:types
# 有 Docker Engine + Compose（支持 !reset）、Node 24 和 jq：
# 构建真实镜像并创建独立生产 Compose 项目，完成后仅清理本次测试资源
bash infra/scripts/test-compose.sh
```

`pnpm test:e2e` 需要已迁移且已通过 Worker 填充的 Fixture 数据库；Playwright 自动启动本地 API/Web（已有服务可复用）。测试复用一次真实登录的会话，每个测试独立浏览器上下文，不降低服务端登录限流。`pnpm api:types` 从实际注册路由生成 `docs/openapi.json` 和 `apps/web/src/generated/api.d.ts`。

编译产物可直接用 Node 运行，不能只以“编译成功”代替运行验证：

```bash
node apps/api/dist/migrate.js
node apps/api/dist/index.js
node apps/worker/dist/index.js --once
node apps/worker/dist/health.js
```

密码轮换：在可信服务器环境更新 `ADMIN_PASSWORD` 后执行 `pnpm admin:reset`（开发）或容器内 `node apps/api/dist/admin.js`（生产）。命令会撤销该管理员全部 Session，不打印密码。Session Secret 的更换不能替代撤销数据库 Session。

## 发布与生产部署

提交遵循 Conventional Commits：`fix` → patch、`feat` → minor、breaking change → major。`.github/workflows/ci-release.yml` 在同一工作流内按依赖运行验证、semantic-release、GHCR 镜像、Release 镜像清单和 Vercel，不依赖 GITHUB_TOKEN 创建的 Tag/Release 触发第二个普通工作流。前端 job 检出同一 Release commit，通过锁定版本的 Vercel CLI pull/build 后上传预构建产物；项目使用仓库根目录、Node 24，关闭 Git 自动部署。需要 `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID` Secrets，前端仅注入公开 API 地址和版本/SHA。发布状态、配置及用户最后执行的域名映射见 [自动发布与服务器更新](docs/23-release-and-update.md)。真实 API/Worker 镜像及独立生产 Compose 已在本地验收通过，包含四服务健康、迁移/采集幂等、容器替换后持久化与备份恢复；目标服务器由运维独立部署。

1. 配置安全的生产 `.env`，参考 `infra/scripts/deploy.example.env` 创建 `deploy.env`。
2. 在宿主机安装 Nginx，替换 `infra/nginx/financial-radar.conf` 中域名与证书；配置同站子域或合适的 Secure/SameSite Cookie、精确 CORS Origin。
3. Release 与镜像发布后，服务器执行 `sudo bash /opt/financial-radar/infra/scripts/deploy.sh`。默认选择最新已完成镜像发布的稳定 Release，也可用 `--version vX.Y.Z` 指定版本。脚本校验发布清单与镜像摘要，先备份再迁移，并保存已验证的版本。
4. 使用 `check-health.sh`、`backup.sh`、`rollback.sh`。恢复到新数据库使用 `restore.sh`，不能把应用回滚等同于数据库回滚。

生产 PG/Redis 无公网映射，API 仅映射宿主 loopback；部署不删除数据卷，Nginx 仅在 `nginx -t` 成功后平滑 reload。完整步骤及故障处理见 [部署手册](docs/20-deployment-runbook.md)、[Worker 运维](docs/worker-operation.md)、[恢复演练](docs/recovery-drill.md)。

## 工程结构

```text
apps/web          Vue 3 + Pinia + Vue Query + Element Plus + ECharts
apps/api          Hono / OpenAPI / 鉴权 / 按域路由
apps/worker       BullMQ / 采集 / 事务处理 / AI / 通知 / 恢复
packages/shared   Zod DTO 与安全规则 Schema
packages/database Drizzle Schema / SQL Migration / Session 与事实库
packages/connectors 统一来源生命周期与范围型链上适配器
packages/signals  去重 / 两套评分 / 生命周期 / 规则 / 可知时间回放
packages/ai       结构化分析 / Provider / 证据校验
packages/notifications Telegram / 飞书 / Bark
packages/config   环境变量校验
packages/observability 脱敏日志 / 分位数
infra             镜像 / Nginx / 部署、备份、恢复、回滚
```

设计文档在 docs/00–18；日历、评分与部署补充文档及实际验收记录另行维护。共享 DTO/JSONB 合并的领域关系、实现覆盖和未接入项见 [验收证据](docs/acceptance.md)。
