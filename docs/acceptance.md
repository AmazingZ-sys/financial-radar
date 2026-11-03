# Financial Radar 验收记录

日期：2026-11-02，Asia/Shanghai。此文件描述实际执行结果，不把设计、Fixture、外部服务和生产部署混为一项。原始需求末尾截断，已收到部分作为实现基线。

## 2026-11-03 · 前端迁移 Vercel

将前端发布从 Netlify 改为 Vercel；根 `vercel.json` 使用仓库根目录、Vite、冻结 pnpm 安装、`@radar/web` 构建及 `apps/web/dist` 输出，保留 SPA 路由回退、哈希资源长期缓存和原安全响应头。固定 Vercel CLI 65.10.0，删除 Netlify CLI 与旧托管配置。`.vercel` 项目状态、下载的环境文件和产物均忽略提交及 Docker 上下文。

同一 workflow 保留 verify → release → API/Worker images → image-manifest → vercel 依赖，前端检出 Release commit，执行 `vercel pull`、`vercel build --prod`、`vercel deploy --prebuilt --prod`。三个 Vercel Secrets 缺失时明确失败；实际部署后保存 URL/版本/commit 收据至 Actions artifact 与 job summary。关闭 Vercel Git 自动部署以防绕过质量门禁。生产 API 地址、正式 Web Origin、SameSite=Lax 和 CSRF 契约保持现有部署约定，临时 Vercel 域名仅可验收静态托管。

本地 Node 24.15.0 实际验证：

- `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 均通过。
- `pnpm test`：16 个文件、113 项测试通过。
- `pnpm test:integration`：隔离真实 PostgreSQL 17 / Redis 7.4，70 项主集成、35 项历史流水线、48 项配置/API 检查和 86 项 live/fixture 隔离断言通过。
- `CI=true pnpm test:e2e`：Chromium 13/13 通过；Fixture 不外发通知。测试仅清理本次隔离容器，无本地 API/Web 残留监听。
- `pnpm security:check`、`pnpm audit --prod --audit-level high`、actionlint 与 `git diff --check` 均通过。
- 使用明确标记为本地验证的临时项目设置、无云端 Token，执行 `vercel build --prod` 成功。Build Output v3 先匹配真实静态文件再回退 SPA；21 项资源、入口及 favicon 齐全，生产 API 地址正确、安全头和资源缓存保留，无 Functions 或 sourcemap。临时设置与产物移至 `.local/vercel-offline-validation`，未把本地构建描述为云端发布。

日志位于忽略提交的 `.local/vercel-{install,typecheck,lint,format,unit,build,integration,security,audit,offline-build}.log`。本地验收后，经用户明确授权创建团队范围专用 Token（有效期至 2027-11-03），并加密保存 GitHub 的 `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`。实际项目 `Amazing's projects / financial-radar` 使用 Node 24.x 和仓库根目录，Vercel Production 环境仅增加公开 API 地址。此前章节的 Netlify 发布结果保留为历史证据。

[迁移 PR #1](https://github.com/AmazingZ-sys/financial-radar/pull/1) 的 [CI 41585827434](https://github.com/AmazingZ-sys/financial-radar/actions/runs/41585827434) 全部通过后合并至 main；[正式 Actions 41586393459](https://github.com/AmazingZ-sys/financial-radar/actions/runs/41586393459) 的 verify、release、API/Worker images、image-manifest、vercel 全部成功，发布 [v1.1.1](https://github.com/AmazingZ-sys/financial-radar/releases/tag/v1.1.1)。Vercel 实际部署 `dpl_AHMLzVnhGQwzBNaB7xVinUiJo2gM` 为 READY / production，Release 与部署 metadata 对应 commit `918f038b30e70a058864bf4600f301bf4828f41d`；Actions 的 `vercel-v1.1.1` artifact 包含同一 URL/版本/SHA 收据。

[生产别名](https://financial-radar.vercel.app) 的 `/login`、深层项目路由、入口 JS 和 favicon 均 HTTP 200；深层路由与入口返回同一 HTML，JS 为正确 MIME、immutable 一年缓存，HTML 含原 CSP/nosniff/referrer 头，实际 JS 使用生产 API 地址。HTTP 与云端收据保存在 `.local/vercel-http-receipt.json`、`.local/vercel-cloud-receipt.json` 和 `.local/vercel-ci-receipt/`。浏览器另行只读验证登录页，未登录或修改生产数据。

Vercel 已绑定 `radar.amazingzsys.site` 到 Production。用户随后完成 DNS 切换：权威服务器 `heron.dnspod.net` 实际返回 `radar` 的 CNAME → `6ad0a87c00f0d82f.vercel-dns-017.com`，Vercel 页面显示 Valid Configuration。正式域名 `/login`、深层项目路由、入口 JS 与 favicon 经有效 HTTPS 返回 200，响应 `Server: Vercel` 与 `X-Vercel-Id` 确认已由新托管提供；SPA、安全头、哈希缓存和生产 API 地址检查通过。API `/health`、`/ready` 返回 200；匿名 `/api/v1/auth/me` 返回预期 401，均允许精确正式 Origin 和 credentials CORS。收据为 `.local/vercel-http-receipt.json`、`.local/vercel-domain-api-receipt.json`，Vercel 别名静态收据另存 `.local/vercel-alias-http-receipt.json`。

正式域名的浏览器验证沿用已有 HttpOnly 会话，从 `/login` 自动进入雷达总览，显示「系统连接正常」并加载真实 API 数据；只读截图在 `.local/vercel-production-domain.png`，Vercel Valid Configuration 截图在 `.local/vercel-domain-valid.png`。临时 Vercel 域名未加入生产 Origin；本次未重新提交管理员登录表单、写入或退出，不声称完整生产会话流程验收已完成。镜像发布亦不表示用户服务器已更新。专用发布 Token 的本地中转文件在 Secrets 配置和部署验收后删除，不提交或留在浏览器业务存储。

## 交付范围

| 领域      | 已实现并可运行                                                                                               | 边界                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 工程      | pnpm workspace / Turbo；Vue、Hono、独立Worker；strict TypeScript                                             | Node 24 LTS，本地使用24.15.0；依赖固定lockfile                                                           |
| 持久化    | 29张业务表；Drizzle Schema、2个增量SQL迁移、checksum/事务锁、管理员初始化                                    | JSONB合并event_assets/evidence、project_assets/sources、AI usage与分析状态；并非原建议每个关系均单独建表 |
| API       | 41个OpenAPI路径、47个HTTP操作；Zod输入输出、统一错误/分页/过滤                                               | 按业务域路由，数据库访问集中在后端；前端不接触密钥                                                       |
| 账户      | scrypt独立salt、hashed session、HttpOnly、CSRF/Origin、管理员权限、Redis限流、审计、密码轮换/撤销会话        | 单管理员起步；没有实现公开自助注册、细粒度团队RBAC                                                       |
| 控制台    | 总览、事件/证据、机会/时间线/指标、行情、日历、规则、通知、源健康、系统/观察列表、AI人工复核/版本权重        | 中文、主题、响应式与加载/空/错/Retry；未知行情为空，不填充样本价格                                       |
| 采集      | Fed RSS、GitHub Release、Coinbase ticker、Treasury日度、UniSat、指定EVM Factory与Solana Program、已知资产DEX | 全链部署/全量地址统计不在当前适配器覆盖范围；不依赖DEX广告列表证明新币可信                               |
| 流水线    | 原始持久化→标准化→身份/相似去重→规则/独立评分→项目/信号→事务通知/outbox→尝试记录；历史指标差分和时钟窗口扫描 | 原始项失败不前移checkpoint；严重风险有独立下限；只读信息，不交易/签名；UniSat/DEX仍是有界范围            |
| 回放      | 依发布时间/首次观察/采集的可知时间过滤，存储当时信号和分数解释                                               | 无可靠完整ORDI历史证据包，未声称重建真实历史收益                                                         |
| AI        | Provider、JSON/证据校验、预算预留/UTC日限额、缓存/退避/降级、人工复核                                        | 未配置真实模型密钥；费用是保守预留与估算；语义真实性仍需来源核验与人工研究                               |
| 日历/日报 | PG日历、可靠来源管理员导入、未知值/发布确认、UTC日摘要接口                                                   | Live没有自动官方日历源时为空；日报从已存事实/已有分析生成，无自动每日外发订阅                            |
| 通知      | Telegram/飞书/Bark，渠道测试、启停、重试、模板、冷却/时段、尝试审计                                          | Fixture永不外发；SENT只表示平台接受；响应丢失时不能保证第三方exactly-once或用户已读                      |
| 运维      | Compose、宿主Nginx模板、版本/摘要部署、备份/新库恢复/应用回滚、GHCR+Vercel同workflow发布链                   | 目标生产服务器与TLS由用户配置；GHCR/Vercel发布已完成，前端DNS已由用户切换并验证                          |

## 已执行质量门禁

| 命令/过程                                         | 实际结果                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --ignore-scripts` | 12个workspace项目，锁文件可复现安装                                                |
| `pnpm typecheck`                                  | 全包strict检查与根scripts/tests工具检查通过                                        |
| `pnpm lint` / `pnpm format:check`                 | 通过，无忽略整个业务目录来规避检查                                                 |
| `pnpm test`                                       | 13个文件、95项测试通过（包含22项部署脚本发布校验与故障路径测试）                   |
| `pnpm test:integration`                           | 真实PG/Redis，70项纵向/API检查 + 35项历史PG检查 + 86项Fixture/live双向隔离断言通过 |
| `pnpm --filter @radar/worker recovery`            | 8项隔离真实进程恢复检查通过，结束清理自身临时资源                                  |
| `pnpm test:e2e`                                   | Chromium 10/10通过（29.2s），真实API，无伪造业务响应                               |
| `pnpm build`                                      | Web/API/Worker及相关包成功；编译产物直接Node启动另经验证                           |
| `pnpm api:types`                                  | 实际路由生成OpenAPI和前端声明；CI检查生成契约漂移                                  |
| `pnpm security:check`                             | 源码凭据模式/动态执行扫描通过，不打印匹配密钥                                      |
| `pnpm audit --prod --audit-level moderate`        | 未发现已知生产依赖漏洞；修复了最初Hono Node adapter安全公告涉及的旧版本            |
| Compose config / Bash / actionlint                | 生产/开发Compose可解析、脚本语法通过、actionlint静态检查通过                       |
| `bash infra/scripts/test-compose.sh`              | API/Worker真实镜像构建及隔离四服务生产Compose验收通过，详见下节                    |

历史专项通过35项真实PG检查：9个历史信号与2个窗口信号，覆盖信号/事件/证据/独立评分、规则通知outbox、并发重试、晚到与未来样本、无数值条款撤销，以及部署首见只提示一次。新增摘要断言验证严重风险至少85分、300%真实参与者增长、匹配评分明细与证据，以及后续普通快照不解除风险、持有人数不覆盖参与者增长；首次未来观测只留原始证据，旧记录缺观测时间时从可知指标或摘要时间恢复基线，迟到数据不能回滚当前状态。主集成额外验证这些对象能经鉴权API读取且在Live不可见。独立入口为 `pnpm exec tsx scripts/history-integration.ts`，也已纳入 `pnpm test:integration`。

本地详细输出在忽略提交的 `.local/{typecheck-release,integration-release,unit-release,build-release,e2e-current,recovery-final}.log`。E2E覆盖真实登录、证据/项目详情、规则CRUD与持久化、主题、390px移动无溢出、未知凭据、日历未知字段、时区、评分版本不覆盖、网络故障Retry、来源启停恢复、人工复核不改变事实评分、原始payload折叠、评分解释和规则来源筛选持久化。桌面与移动最终截图在 `.local/{dashboard-final,opportunities-final,opportunities-mobile-final}.png`；Web和恢复专项记录分别见 `web-acceptance.md`、`recovery-drill.md`。

## 数据源真实验证

- Fed：读取20条官方RSS并标准化。
- GitHub：读取ordinals/ord的30条Release并标准化。
- Treasury：官方XML实际HTTP200；63条原始项对应63条观测，2Y/10Y/30Y三期限；来源业务日期2026-10-01至10-30；重复采集后仍63条。精确发布时间未知、delaySeconds=null，不生成伪造盘中异动。
- Coinbase：当前环境网络/超时，未记为成功。已实现有界重试和失败状态，不使用Fixture回填Live。
- UniSat/EVM/Solana/DEX范围适配：契约/Fixture与错误路径测试通过；没有生产授权密钥/范围，未声称全链生产监控验收。
- UniSat 每轮保留稳定资产 key 下的 snapshot raw 项，`sourcePublishedAt` 保持未知，部署时间仅作 `eventOccurredAt`；采集最近50条未完成部署和已完成尾部20条，不能代表全量。DEX 只接受管理员提供的已知 token 地址列表，空列表显示未配置。
- 历史检测单元与Worker链路已实现：三次可知快照按观测间隔计算铸造速度加速，统一供给上限；明确 `uniqueParticipants` 才计算独立参与者增长，`holders` 不作替代；流动性/成交量/可靠社群计数、项目阶段/可信度变化及已核验参与窗口临近/到期均保存独立信号和证据。窗口时钟扫描在Worker `--once` 与reconcile运行，稳定键防重复；缺失字段、未来/乱序样本、条件撤销和时间异常不触发。
- BLS/EIA：已研究当前官方接口与授权；本版未接入Live采集。黄金、WTI/Brent等授权实时行情未接入；界面对应数值未知。FRED的AI/存储条款冲突使默认Live禁用。

## 恢复与安全证据

真实隔离PG/Redis停止后`/ready=503`、同目录/端口重启后`200`，事实计数保持；正式Worker有心跳后SIGKILL，再执行恢复，过期SENDING/QUEUED租约补偿且dedup无重复；持久冷却阻止重启后的提前请求。人工构造租约过期不能证明精准打断“渠道接受后DB提交前”窗口；Telegram接口无本系统业务幂等键，超时仍可能重复，已记录不确定性。

Fixture/live API双向隔离防止同库保留的合成数据出现在Live列表、直接ID详情、统计、行情、通知、回放或AI用量。系统元数据/用户规则和设置可以保留跨模式；Worker心跳校验version、mode与commit，避免旧进程残留造成假健康。

## 容器与生产发布状态

Docker Desktop 29.9.2下实际构建API与Worker镜像，最终冻结代码在唯一隔离项目 `radar-acceptance-d3556adb2c5a` 运行生产Compose；不映射主机端口，不占用开发服务。验证结果：

- 随机特殊字符PG/Redis密码及编码连接串可用；两次迁移保留2个版本，两次采集保持5条raw、5个event、4个project和4个signal。
- API、Worker、PostgreSQL、Redis四服务全部healthy；真实生产管理员登录、Secure/HttpOnly Session Cookie、CSRF和受保护API通过；应用容器以非root用户运行。
- 强制替换PG/Redis容器后，数据库事实计数和Redis AOF标记均保留；重新启动应用后健康检查通过。
- 实际调用 `backup.sh` 生成pg_dump档案，再用 `restore.sh` 恢复到新库，五类记录计数一致；只清理本次项目的容器、网络和卷。

最终验收证据在忽略提交的 `.local/docker-acceptance/radar-acceptance-d3556adb2c5a/result.json`；此前三个独立验收项目 `radar-acceptance-12dbd8868b90`、`radar-acceptance-716f13fb141f`、`radar-acceptance-a329334caab7` 的同名文件也保留在该父目录。各次均包含日志和备份恢复记录。测试使用本地验收镜像与测试revision；该revision不是线上Release证据，工作区实现尚未提交。可重复入口 `infra/scripts/test-compose.sh` 已加入CI验证阶段。此前仅生产依赖+dist+迁移的隔离文件布局验证也通过，并发现修复ESM CommonJS require和迁移模块打包后重复自执行的问题。

GitHub Actions、GHCR与Netlify的实际发布证据见下节。目标服务器部署、宿主Nginx/TLS及真实IM/LLM联通仍由用户另行配置和验收；前端上线不能替代这些执行证据。

## 自动发布收尾

本轮统一空白 API 前缀回退，Netlify CLI 显式选择 Web workspace 并禁用二次构建；配置站点与 GitHub 加密 Secrets，临时 API 前缀为 `/api/v1`，后端域名另行配置。部署脚本默认选择已有完整发布清单的稳定 Release，校验 metadata/manifest 与实际镜像标签，直接拉不可变 digest。新增测试覆盖未完成 Release、清单版本/commit/仓库异常、私有资产下载失败与既有 pin 保持。首次云端发布已完成，服务器和 Nginx 由用户自行部署。

首次完整云端发布为 v1.0.0，对应代码 `5a15de20e45d73c258019f978135d1895fbc96af`，实际 [Actions run 41405313336](https://github.com/AmazingZ-sys/financial-radar/actions/runs/41405313336) 的 verify、release、API/Worker images、image-manifest 和 Netlify 全部成功；[Release](https://github.com/AmazingZ-sys/financial-radar/releases/tag/v1.0.0) 含 Changelog、release-metadata 与 image-manifest，两个实际GHCR digest经远程inspect成功，平台linux/amd64。[Netlify生产站点](https://financial-radar-amazingz.netlify.app) HTTP200，静态资源与CSP有效；后端未接通，未声称线上登录/业务接口可用。

部署脚本自身通过匿名GitHub API实际选择v1.0.0并加载两个不可变digest/commit成功（`.local/release-receipt-smoke/receipt.json`）。后续补丁增加纯64hex伪镜像地址拒绝测试，全量本地95项通过，部署专项22项；后续发行结果以GitHub Releases/Actions为准。最初一次云端契约检查发现生成器未正确读取格式配置，修复后两次生成hash一致且schema语义不变，再次云端检查通过，未移除门禁。

## 生产域名配置

用户确认前端为 `https://radar.amazingzsys.site`、后端为 `https://api.radar.amazingzsys.site`。前端生产 API 前缀已配置为 `https://api.radar.amazingzsys.site/api/v1`，同时写入 GitHub Variable、Netlify build environment 和工作流默认值。本地开发仍使用 `/api/v1`。后端 `WEB_ORIGIN=https://radar.amazingzsys.site`，Secure Cookie 与 SameSite=Lax；采用前端直接请求 API 的方式，不配置 Netlify API 代理。

本轮 `typecheck`、`lint`、95项单测、build、70项主集成+35项历史PG+86项模式隔离通过；OpenAPI契约无漂移。生产模式Web构建另核对编译产物中的实际API地址。Nginx模板填入API子域与证书路径，80端口保留ACME webroot；在官方Nginx容器中使用本地临时测试证书执行 `nginx -t` 通过，日志 `.local/domain-nginx/config-check.log`。这不代表生产证书或用户服务器部署已完成。

本轮DNS检查时，前端和API两个域名均返回A记录 `49.51.38.38`，API HTTPS证书不匹配主机名；Netlify站点已登记前端custom domain。用户需要按Netlify要求调整前端DNS，并在API服务器完成对应证书与后端部署。Ubuntu 22.04/24.04具体操作见 [实际域名首装指南](24-server-api-radar-amazingzsys-site.md)，服务器操作由用户执行，最终网络状态以实时检查为准。

## 生产宿主端口调整 · 2026-11-03

根据服务器已有 3000 服务，将生产宿主映射改为 `127.0.0.1:13000:3000`，同步宿主健康 URL 与 Nginx upstream；容器内 3000 和本地开发保持一致。本轮 typecheck、lint、95 项单测、build、security:check、format:check、70 项主集成 + 35 项历史 PG + 86 项模式隔离通过，日志为 `.local/port-*.log`。Compose 实际解析确认 host_ip=127.0.0.1、published=13000、target=3000；Nginx 使用本地临时测试证书在官方容器内 `nginx -t` 通过（`.local/port-nginx/config-check.log`）。本地检查不代表已更改用户服务器。

在本地用独立临时服务实际占用宿主 3000，同时运行唯一隔离 Compose 项目 `radar-acceptance-9cbbd005413f`；API 的宿主 `13000/ready` 返回成功，`compose port api 3000` 实际输出 `127.0.0.1:13000`，原 3000 服务仍正常响应。API/Worker/PostgreSQL/Redis 四服务健康，生产管理员登录、Secure/HttpOnly Cookie、CSRF 与受保护 API 验证通过。实际日志见 `.local/port-compose.log`，宿主端口证据见 `.local/docker-acceptance/radar-acceptance-9cbbd005413f/host-port.txt`；未操作用户生产环境。

## 控制台集成配置与多领域新闻 · 2026-11-03

本轮设计先行记录在 [25 可配置集成](25-configurable-integrations.md)、[26 新闻来源目录](26-news-source-catalog.md)。实现位于 `codex/configurable-integrations`，本轮未提交、推送或更新生产部署。

- 系统管理新增 OpenAI-compatible AI 配置：中转 Base URL、模型、API Key、启停、超时、JSON 模式开关与预算；保存后供后续任务读取，测试已保存模型的一次真实 completion（Fixture 明确跳过）。缓存区分模型和服务配置；页面密钥不进入持久存储或查询缓存。
- 通知中心可配置 Telegram Bot Token/Chat ID、飞书官方 Webhook、Bark 完整地址。凭据 AES-256-GCM 加密入库，环境变量保留初始默认；空白保留、明确清除后不回退环境密钥。API/Worker 共享服务器根密钥，不回显 Token/Webhook/设备地址，审计只记录字段名与状态。损坏密文的页面仍有修复入口，发送失败会持久化并释放租约。
- 数据源新增分类目录、ECB 政策公告和 BBC 全球/财经/科技订阅；自定义公共 HTTPS RSS/Atom 保存后约15秒内同步注册、排程。地址不可原地替换，最短60秒轮询；XML 禁用 DTD/实体、限制响应与条目数；保存原标题、摘要、来源时间或 null、首次发现时间，重复条目幂等。新闻进入热点与规则链，编辑性新闻/自定义新闻保持 UNVERIFIED。标准分类与旧分类并存供新事件筛选，既有持久化事件不改写。
- 动态出站地址校验 DNS 并固定实际连接地址，拒绝内网/保留地址、URL 用户信息及重定向，限制超时与2MB响应。自定义订阅目前不支持查询参数、片段、密钥订阅或私网地址；AI Base URL 不接受查询参数。密钥轮换、服务器根密钥备份与恢复语义已同步运维文档。
- 修复仅在页面保存 AI Key 时不排分析任务的问题，以及运行模式切换后遗留 AI 任务可能跨 live/fixture 处理的问题。Fixture 分析与真实凭据解密、预算独立，不占用真实每日调用额度；确定性规则不依赖 AI 可用性。启动时不误停用并发新增订阅，无效持久化订阅明确停用且不调度。

实际使用 Node 24.15.0、pnpm 10.26.2 执行：

| 检查                                       | 结果与证据                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`、`pnpm lint`              | 全包 strict 与工具脚本通过；`.local/integrations-{typecheck,lint}.log`                                                                                      |
| `pnpm test`                                | 16个文件、112项通过；含加密/篡改、服务端安全视图、DNS固定/私网/重定向/响应上限、AI中转契约/JSON模式、RSS/Atom/日期/标准分类；`.local/integrations-unit.log` |
| `pnpm test:integration`                    | 本地真实 PostgreSQL + 独立 Redis：70项主检查、48项配置/API/新闻流水线检查、35项历史PG检查、86项模式隔离断言通过；`.local/integrations-pg.log`               |
| `pnpm test:e2e`                            | Chromium 13/13通过，真实 API：AI保存刷新、凭据草稿清空、非加密分类目录与Fixture限制，以及既有页面回归；`.local/integrations-e2e.log`                        |
| `pnpm --filter @radar/worker recovery`     | 8项真实进程恢复通过；`.local/integrations-recovery.log`、`.local/recovery-latest.json`                                                                      |
| `pnpm build`                               | API、Worker、Web及依赖构建通过；`.local/integrations-build.log`                                                                                             |
| 编译产物启动                               | 直接Node启动编译API，PG/Redis readiness、鉴权及新路由契约通过；编译Worker `--once`通过；`.local/integrations-compiled-{api,worker}.log`                     |
| `pnpm api:types`                           | 实际新路由生成OpenAPI和前端类型；`.local/integrations-api-types.log`                                                                                        |
| `pnpm format:check`、`pnpm security:check` | 通过；`.local/integrations-{format,security}.log`                                                                                                           |
| 视觉检查                                   | AI配置与来源目录1440px/390px无横向溢出，已查看截图；`.local/integrations-ui-{ai,sources}-{1440,390}.png`                                                    |

新增配置集成检查使用明确命名的合成新闻传输和占位凭据，仅在非生产测试库短暂构造live路径并清理，不是实际新闻采集或供应商联通证据。覆盖空环境Key下热读取、加密恢复/清除、损坏通知租约、CSRF/SSRF、目录模式、来源创建幂等/动态注册/禁用、未知发布时间、实际PG热点写入/重复采集、AI模式隔离。反复本地登录触发原有限流后，最终套件使用独立测试Redis完成，未降低登录保护。

恢复演练首次发现既有固定Fixture窗口在2026-11-03到期后产生第6条合法事件，原脚本将事件总数固定为5导致失败。脚本现在严格校验5条原始项和5条基础事件，只额外计入已标识的窗口时钟事件；恢复前后仍比较完整事实计数及去重，未放宽业务处理断言。

外部只读验证：ECB 使用本轮 Node HTTPS采集/解析链实际读到15条；BBC 三个公开 Feed 经代理路径读取HTTP200，但本机 Node 直连DNS路径遭拒/超时，已在来源目录文档区分，不能声称BBC生产Worker已可用。没有使用真实 AI/IM 凭据测试，也没有修改用户线上配置；真实中转站计费/通知接受状态和部署网络仍须在更新后的环境测试。本轮没有数据库结构迁移或破坏性DDL。

## v1.1 发布准备 · 2026-11-03

用户明确授权前端生产发布和 API/Worker 最新镜像发布。复核现有版本为 v1.0.3，发布路径为 main 推送 → verify → semantic-release → GHCR 两个镜像 → 镜像清单 → Netlify。服务器更新步骤已写入 [v1.1.0 指南](27-v1.1-server-update.md)，不把镜像发布等同于用户服务器已更新。

发布复核修复动态出站只固定首个 DNS 地址的问题：现在向 Node24 提供全部已校验的固定地址，支持 IPv6 失败后回退 IPv4，单地址回调优先IPv4，仍在请求前拒绝混合私网DNS。新增回归断言验证多地址固定与不重复解析，5项出站测试、config 类型和 lint 已通过。`deploy.env` 已加入忽略规则，防止服务器部署凭据误提交。

## v1.1.0 生产前端与 API/Worker 镜像发布 · 2026-11-03

- GitHub Actions [41568826737](https://github.com/AmazingZ-sys/financial-radar/actions/runs/41568826737) 的 verify、release、API image、Worker image、image-manifest 与 Netlify 全部成功；verify 包含生成契约、typecheck、lint、格式、单测、PostgreSQL/Redis 集成、构建、生产 Compose 验收、安全扫描、依赖审计和 Playwright E2E。
- Release `v1.1.0` 指向 `a71d6ea7aea2d4b4a5226aa3c3cf06283c1264e1`；发布 metadata 与 image-manifest 的版本及完整 commit SHA 相互一致。远端 immutable digest 和 tag digest 一致：API `sha256:6bb068d6a4cdac5c53d7a87cd0d98ae095f0ba137ddedc3635dde7235fdc7c51`、Worker `sha256:7cee351ce967156c760d76539007609896bb22cf3f5f7e26a6ae3479445b056e`；两者远端镜像均含 `linux/amd64` manifest。
- Netlify 于03:01 UTC发布生产版。`https://radar.amazingzsys.site` 与 `https://financial-radar-amazingz.netlify.app` 均返回HTTP 200，相同的新入口JS/CSS已替换原资源；新懒加载资源含AI中转配置、Telegram/飞书/Bark配置、RSS/Atom与多分类目录功能，生产API前缀仍为 `https://api.radar.amazingzsys.site/api/v1`。仅做公开页面与静态资源核验，未登录或更改生产数据。核验收据和抓取摘要位于忽略提交的 `.local/published-v1.1.0/`。
- 目标 API 服务器只读健康检查仍返回 `v1.0.3`。因此此证据确认前端和后端镜像已发布，不表示用户服务器已升级；服务器更新与应用验证步骤见 [v1.1.0 服务器更新指南](27-v1.1-server-update.md)。目标服务器更新、真实LLM/IM凭据联通和Feed连通性仍待服务器侧执行与核验。
