# Financial Radar 验收记录

日期：2026-11-02，Asia/Shanghai。此文件描述实际执行结果，不把设计、Fixture、外部服务和生产部署混为一项。原始需求末尾截断，已收到部分作为实现基线。

## 2026-11-04 · Solana 积压补偿与黄金/原油熔断排查

15:02–15:10（Asia/Shanghai）通过已有登录会话只读查看生产来源页与健康历史：Solana 在已有成功后持续报“指定program积压超过100交易”，配置的公开 Program 为 `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`，与 [Pump 官方文档](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)一致；WTI 无成功记录，13:04、14:04 多次 HTTP 406 后熔断；黄金无成功记录，持续约1秒网络错误后熔断。未编辑生产配置、未读取或使用 RPC 凭据。

先新增[29 Solana补偿](29-solana-history-recovery.md)、[30商品来源恢复](30-commodity-source-recovery.md)、[31只读诊断](31-source-diagnostics.md)，再实现：

- Solana 移除满100条直接永久失败，按before分页扫描并实际找到旧检查点后从旧到新回放。扫描每轮100签名、交易读取每轮20笔；页摘要、待处理签名与恢复进度持久化，重建connector后继续。null交易、首轮/后续空页未找到检查点、RPC失败或页面不完整均停止，不越过缺口。未完成保持degraded和原last_success_at，完成后恢复healthy。
- EIA 实际媒体类型本地可返回application/x-zip-compressed，请求增加该类型、标准ZIP、二进制和低优先级通配Accept，保留ZIP/序列/日期/单位验证。生产406是否由请求头导致尚未证实：本地代理出口下原Accept与通配均可200，不能将兼容修改视为生产根因已确认。
- HTTP 网络错误仅保留白名单DNS/TLS/连接/超时码，熔断附带最近安全原因；不回显原始URL、error message、凭据或代理配置。失败响应主动取消body，连续失败不缩短Retry-After冷却，成功清除原因与冷却。
- 新增固定公开端点的只读诊断脚本，不读应用凭据、不写DB、不输出响应正文或IP，按DNS/TCP/TLS/HTTP阶段区分故障，供服务器出口复验。黄金本地可成功读取，生产现有通用错误无法追溯具体网络原因；尚待服务器脚本输出或更新Worker后的安全错误码。

Node 24.15.0 正式验证通过，日志位于忽略提交的 `.local/source-recovery-test/`：`pnpm typecheck`、`pnpm lint`、`pnpm test`（19文件、192项）、`pnpm build`（9任务）通过。独立真实PostgreSQL 18 / Redis 7.4.2内全部集成通过：新增Solana补偿25项、商品恢复20项，以及Solana版本13、EVM分页12、UniSat41、主流程70、历史35、配置62、来源配置18、模式隔离86项。Solana验证125笔连续交易完整处理、跨轮/重启恢复、失败cursor保留、4条合成Mint落库及重放幂等；商品验证HTTP406/ENOTFOUND不写行情或前进cursor，错误脱敏可见，恢复后raw/market各1条且重放幂等。所有合成事实均明确Fixture，未向外部平台发送消息。

`pnpm format:check`、`pnpm security:check` 与 `git diff --check` 通过；独立只读审查未发现本轮改动引入的数据丢失、错误恢复或凭据回显问题。既有未提交UniSat改动保留并随全量回归验证。

本轮未发布Release、未更新生产Worker，也未重置或删除生产cursor。当前Pump Program在每轮20笔、默认60秒轮询预算下不能承诺持续追平；高流量实时覆盖仍需有预算的索引/流式采集方案，不能以分页补偿验收替代。WTI保持日度参考价，黄金/原油是否生产恢复以服务器后续真实成功记录为准。

## 2026-11-04 · UniSat 历史部署重复采集修复

用户反馈 2023 年部署被反复记录为 2026 年新发现。根因是每轮固定读取状态首部，且原始 ID 与事件身份包含本轮时间；状态未变化仍绕过数据库去重。先更新 [03 数据源](03-data-sources.md) 并新增 [28 近期部署监控](28-unisat-live-discovery.md)，再实现：

- 按官方 offset/total 读取部署排序的首尾页，兼容排序方向未声明的接口；选最多50条未完成、20条已完成候选，仅接纳近7天的有效部署。2023 年、未知、无效和未来部署均不生成 raw/event/project/新部署信号；无 total 时覆盖仅限首部，不声称全量。
- checkpoint 持久保存实际状态指纹和批次序号，排除观察时间、索引高度及无关元数据；不变状态零新增，真实变化与 A→B→A 回归均保留。标题改为「BRC-20 状态更新」，链上部署、未知来源发布、首次发现与采集时间保持独立。
- 新增向前兼容迁移 `0003_source_pending_batches.sql`；UniSat 批次在处理首项前保存到 PostgreSQL。部分处理失败后先重放已保存的响应，完成时与 checkpoint 原子清除 pending；重启恢复不重新读取已变化的供应商响应。重试标准化使用已保存的原始 payload/发布时间，避免篡改证据时间。
- 变化采样携带前一状态最后确认时间及关联指纹，铸造加速按校验后的实际基线间隔计算。回归验证删除不变采样不会制造11倍加速，真实3倍加速仍可检出；缺失、断链、未来及越界基线不产生加速信号，既有6小时门限保留。

Node 24.15.0 本地验收通过，日志保存在忽略提交的 `.local/unisat-test/`：

- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`pnpm security:check` 与 `git diff --check` 通过；构建9个任务成功。
- `pnpm test`：18个文件、176项通过，覆盖时间窗边界、首尾分页、数值格式等价、持久去重、重启、状态回归、确定性身份、缓存边界，以及采样基线与加速误报。
- 隔离真实 PostgreSQL 18 / Redis 7.4.2 的 `pnpm test:integration` 通过：新增 UniSat 41项、主流程70项、历史35项、EVM分页12项、Solana版本13项、配置62项、来源配置/热加载18项、模式隔离86项。UniSat 集成使用真实适配器与显式 Fixture HTTP 响应，验证部分处理失败后 checkpoint 不前进、pending 可重放、恢复期间上游回归不丢失、原始身份与时间不变、成功后删除 pending、后续不变轮询零新增。迁移在已有隔离数据库上执行并重复运行，未删除既有事实；测试结束停止自身服务。

本轮未使用用户 UniSat 凭据实采、未发布或更新生产环境，也未自动清理已有历史数据。后端需先执行新增迁移，再运行更新后的 Worker；原 UniSat Key 可沿用。旧事件保留原始时间与证据，不能把本地 Fixture 验收视为线上修复已生效。

## 2026-11-04 · v1.3.1 发布与前端部署

用户明确授权发布Release与部署，并指定后端由其自行更新。下方两节为发布前本地回归，本节记录随后实际完成的正式发布。

- [Actions 41782757585](https://github.com/AmazingZ-sys/financial-radar/actions/runs/41782757585) 的 verify、release、API/Worker images、image-manifest、vercel 全部成功。云端重新验证17个文件146项单元测试，70/35/62/18/86项既有集成以及EVM分页12项、Solana版本13项集成；18个Chromium E2E全部通过。服务端构建语法、隔离生产Compose启动/持久化/备份恢复、安全扫描与依赖审计均通过。
- [Release v1.3.1](https://github.com/AmazingZ-sys/financial-radar/releases/tag/v1.3.1) 已正式发布，tag与release-metadata均对应 `313793d1db3bd3f0b494703ab016a80f15ea402c`，CHANGELOG、release-metadata、image-manifest三项附件均已上传。包含Ethereum每次最多10块分页及Solana legacy/v0/v1兼容两项修复。
- GHCR只读核验版本与SHA标签、镜像清单、OCI标签及运行环境：API digest为 `sha256:cc8c82814fec0781b32533063755ba8c5a9069c5c4d0d2d353a246a2a05aae3a`，Worker为 `sha256:9c32c3d645fbb9ce017f002800f7e9fe39ae6497631932e84b678d236e50c7e1`。两者均为linux/amd64、Node 24.22.2、非root用户，版本和commit与Release一致；未启动生产应用容器。
- Vercel production [部署](https://financial-radar-87ppedfk9-amazings-projects-6f99eda0.vercel.app) 与GitHub production deployment状态均为success；工作流artifact绑定同一v1.3.1/commit，GitHub deployment ID为 `7539299222`。Release与镜像只读收据保存在忽略提交的 `.local/rpc-release/v1.3.1/`，CI完整验收日志为 `.local/rpc-release/verify-clean.log`。
- [正式域名](https://radar.amazingzsys.site) 完成8项HTTP读取、39项断言：`/login`、`/sources`、入口JS、SourcesPage与CSS均返回200，SPA深层路由、生产API前缀、链配置字段、安全头与一年immutable资源缓存通过。唯一vercel.app部署地址受Vercel SSO保护，未登录或绕过，未进行其资源hash比对；版本身份由工作流artifact、GitHub deployment success及Vercel job `126420689266` 的正式域名alias日志共同绑定。最终收据为 `.local/rpc-release/v1.3.1/frontend-20261104T061638Z/frontend-http-receipt.json`。
- 只读检查时，生产API `/health` 返回200且版本仍为v1.3.0，`/ready` 返回200/ready；未登录或写入生产业务数据。

后端服务器由用户执行 `sudo bash /opt/financial-radar/infra/scripts/deploy.sh --version v1.3.1` 更新API/Worker；本次未操作该服务器，链上采集修复需服务器更新后生效。

## 2026-11-04 · Solana 交易版本兼容与 -32015 错误

用户反馈配置 Solana RPC/Program 后出现 `RPC -32015（参数/额度/历史覆盖需核查）`。核对[Solana 官方迁移说明](https://solana.com/docs/core/transactions/versioned-transactions#preparing-for-v1)与[jsonParsed 结构](https://solana.com/docs/rpc/json-structures)：-32015 表示请求客户端不支持交易版本，固定 maxSupportedTransactionVersion=0 的请求会在读取 v1 交易时失败。先更新数据源设计，再将 getTransaction 的版本上限改为数值1，保留 finalized/jsonParsed 与外层/内部 SPL Token 初始化解析。legacy/v0 继续兼容，v1 新增 transactionConfig 不用于推断资源或费用。残余 -32015 单独显示固定中文版本提示并归类 PERMANENT，响应高于v1的版本也拒绝处理；失败不跳过交易、不推进检查点，不回显供应商原始错误中的地址或凭据。

Node 24.15.0 本地验证，日志位于忽略提交的 `.local/solana-version-test/`：

- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`pnpm security:check` 与 `git diff --check` 通过，构建9个任务成功。
- `pnpm test`：17个文件、146项通过。新增6项覆盖数值1请求、v1内层Token-2022 Mint初始化、legacy/v0兼容、后续-32015错误脱敏与cursor保留、null交易历史及未来版本拒绝；保留上轮Ethereum分页回归。
- 隔离的真实PostgreSQL 18 / Redis 7.4.2中，`pnpm test:integration` 全部通过：新增Solana版本13项、EVM分页12项、主流程70项、历史35项、配置62项、来源配置/热加载18项、模式隔离86项。Solana集成在同轮前一交易读取成功后注入-32015，验证持久cursor不变且无部分事实写入，来源健康与运行错误均脱敏；恢复v1响应后两条事实成功写入，重放幂等。RPC响应均为明确Fixture，未向外部平台发送消息。

本轮完成本地回归，未使用用户RPC凭据实采、未发布Release或更新生产Worker。运行环境需更新Worker代码或镜像后生效；既有每轮最多100笔交易及积压停止的监控边界保留。

## 2026-11-04 · Ethereum 免费 RPC 日志跨度兼容

用户反馈 `eth_getLogs` 返回 HTTP 400 / JSON-RPC -32600，响应明确套餐每次最多允许10个区块。原适配器首次查询 finalized head 向前20块（含首尾21块），后续单次最多200块，均可能超过此限制。本轮先更新数据源设计，再将请求改为每页最多10块，顺序连续读取，每轮仍最多追赶200块。空页继续读取后续范围，尾页不超过 finalized head；沿用本地每秒最多2次请求、超时与退避。逐页验证 Factory、topic、日志区块范围及哈希；全部页成功后才返回cursor，后页失败保留原持久检查点以便完整重试。

Node 24.15.0 本地验证，日志位于忽略提交的 `.local/rpc-pagination-test/`：

- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`pnpm security:check` 与 `git diff --check` 通过，构建9个任务成功。新增集成脚本也通过工具TypeScript与ESLint检查。
- `pnpm test`：17个文件、140项通过。新增回归覆盖拒绝超过10块的合成HTTP400响应、首次21块按10/10/1分页、200块连续追赶、finalized尾页、中途失败从原cursor重试，以及拒绝跨页日志。
- 隔离的真实PostgreSQL 18 / Redis 7.4.2中，`pnpm test:integration` 全部通过：新增EVM分页12项、主流程70项、历史35项、配置62项、来源配置/热加载18项、模式隔离86项。分页集成注入合成RPC并显式标记Fixture，验证第二页HTTP400后数据库cursor不变、无部分事实提前提交；恢复后写入两条事实并提交最终cursor，重放无重复。只清理本次随机测试源，服务退出后停止自身进程，保留本地证据文件。

本轮完成本地代码与回归验收，未使用用户RPC凭据实采、未发布Release或更新生产Worker。10块是本系统保守分页上限，不是对所有RPC供应商配额的承诺；运行环境需更新Worker代码或镜像后生效，原RPC与Factory配置可继续沿用。

## 2026-11-04 · 弹窗、接入入口与黄金/原油

本轮先更新数据源、前端、通知与接入配置设计，再完成以下修复：

- 来源页弹窗移至 body，避免页面入场动画的 transform 改变 fixed 定位参照；统一限制弹窗高度，正文独立滚动。通知与规则弹窗同步采用相同约定。1280×600 与 390×640 下，滚动页面后打开仍完整位于视口内，保存/关闭可达，Escape 关闭并恢复焦点。
- 来源页顶部增加「数据源接入设置」，支持 UniSat Key、Ethereum RPC + V2 Factory、Solana RPC + Program、DEX 链与最多 30 个已知 token；提供 UniSat、Alchemy、Helius 与 DEX Screener 官方入口。DEX 公开接口无需 Key。Key 与可能包含 Key 的 RPC URL 仅在服务器加密保存，不回显、不进入浏览器持久存储；空白保留、显式清除屏蔽环境回退。Worker 定期热加载配置，Factory/Program 范围变化不复用旧检查点；RPC 每次请求固定公网 DNS 解析、拒绝私网和重定向。
- 通知中心邮箱卡片直接提供 Gmail SMTP 官方说明与应用专用密码入口；配置弹窗的帮助包含两步验证、主机、端口及 STARTTLS 指引。
- 黄金接入 Gold API 无 Key 公开报价，每 60 秒采样，单位 USD/金衡盎司，保留供应商更新时间；原油接入 EIA 官方 WTI 日度序列，每小时条件请求，单位 USD/桶，保留数据日期且精确发布时间为未知。EIA 流式解压有时间、压缩/解压字节与单行上限，未获得数据时保留错误，不用 Fixture 回填。首页增加黄金/原油卡片并直达对应行情；WTI 默认 30 天，首次黄金单个观测也可见。API 与界面均限制两类来源的最短轮询周期。

Node 24.15.0 本地验证日志与收据位于忽略提交的 `.local/usability-test/`：

- `typecheck`、`lint`、`format:check`、`build`、`security:check`、生产依赖审计与 `git diff --check` 通过；构建 9 个任务成功。新解压依赖固定为修复安全公告的 fflate 0.8.3，审计无已知漏洞。
- 单元测试 17 个文件、135 项通过。真实 PostgreSQL / Redis 集成：主流程 70 项、历史流水线 35 项、配置 62 项、新增来源配置/热加载 18 项、模式隔离 86 项通过。最终运行使用独立 Redis 逻辑库，避免连续本地验收累积限流；生产限流未放宽。
- 首次云端容器门禁发现 fflate 的 ESM `createRequire` 导入与现有 tsup banner 重名，阻止了 Release 与部署；已将 API/Worker banner 导入加别名，并在 CI 构建后检查全部服务端 JS 语法。修复后本地 typecheck、lint、135 项单元测试、构建与全部服务端产物 `node --check` 通过，云端发布以随后独立记录为准。
- Chromium E2E 18/18 通过，覆盖上述弹窗位置、Gmail 链接、来源入口与秘密草稿清除、商品跳转及 WTI 默认时间范围；使用真实本地 API，无业务响应替身。桌面/移动弹窗截图为 `source-dialog-{1280,390}.png`。
- 独立保留的 live 数据库完成 21 项实采 → PostgreSQL → 鉴权 API 验收，收据 `market-live-pg-api.json`：黄金 1 条、WTI 最近 90 条真实观测；重复采集 WTI 后 raw 与行情仍各 90 条，来源时间、首次发现与采集时间独立；无通知入队或发送。该主机访问 EIA 实采使用 `NODE_USE_ENV_PROXY=1`。验收时 EIA 最新数据日为 2026-10-27，明确属于有延迟的日度数据；黄金无历史回填，历史从首次采样累积。

上述本地验收完成后，用户授权发布 Release 与部署，并明确后端由其自行更新。本节取代下方早期记录中「黄金/EIA 未接入」的当前状态，不代表 UniSat 或授权 RPC 已完成生产实采。

2026-11-04 11:42（Asia/Shanghai）发布验收：

- [Actions 41767679975](https://github.com/AmazingZ-sys/financial-radar/actions/runs/41767679975) 的 verify、release、API/Worker images、image-manifest 与 vercel 全部成功。云端重新验证 135 项单元测试、70/35/62/18/86 项各组集成、全部服务端产物语法及隔离生产 Compose 的启动、持久化与备份恢复。18 个 E2E 用例最终通过，其中既有评分编辑成功提示用例在一次重试后通过，其余 17 项一次通过。首次失败运行未产生 Release 或部署。
- [Release v1.3.0](https://github.com/AmazingZ-sys/financial-radar/releases/tag/v1.3.0) 对应 `fad2d16ec4ddeb04386fd762329a91debba05fd4`，已上传 CHANGELOG、release-metadata 与 image-manifest。API digest 为 `sha256:d766885243ee949ae8af1c148270e126ad52523a019f4ff0bd6badf099de1b4a`，Worker 为 `sha256:f5dac3def6036c32e742909928beaf4063a62717ade06dd8411e1c7b5d35f6a8`。GHCR 只读核验版本与 SHA tag 指向相同 digest；两镜像 linux/amd64、Node 24.22.2、非 root，OCI 标签及运行环境均匹配版本/commit。
- Vercel production [部署](https://financial-radar-f9bl3c80u-amazings-projects-6f99eda0.vercel.app) 与 GitHub deployment 状态均 success，artifact 收据绑定同一版本/commit。[正式域名](https://radar.amazingzsys.site) 的 `/login`、`/sources`、`/notifications`、`/markets` 与新资源共 10 项 HTTP 检查通过：来源设置、Gmail 直达链接、商品数据字段、弹窗高度样式、正式 API 前缀、安全头及 JS/CSS immutable 缓存均已生效。全程未登录或写入生产业务数据。
- 只读收据保存在 `.local/usability-release/`，镜像完整摘要为 `v1.3.0/verification-summary.json`，前端为 `frontend-http-receipt.json`。发布后 API `/health` 仍为 v1.2.0，`/ready` 返回 200；镜像/前端发布不代表后端已更新。用户需在服务器执行 `sudo bash /opt/financial-radar/infra/scripts/deploy.sh --version v1.3.0`，完成后来源设置接口与黄金/原油 Worker 采集才会在生产生效，已有 SMTP 配置继续沿用。

## 2026-11-04 · SMTP 邮箱通知

本轮扩展通知渠道为可配置 SMTP 邮箱：主机、自定义端口、TLS/STARTTLS、可选认证、发件人与最多 20 个收件人均由管理员在通知中心配置，也支持服务器环境默认值。凭据继续使用服务端 AES-256-GCM 加密，密码不回显、不持久保存于浏览器。新渠道默认停用，`ensureAdmin` 幂等补种，无破坏性 DDL。规则选择器与 Worker 使用同一 email Provider 契约。空白密码保留、显式清除不回退环境密码，损坏密文仍可重新配置。

SMTP 连接/空闲超时各 10 秒，总投递上限 25 秒并销毁底层 socket；保留证书校验和强制 STARTTLS。4xx（含 AUTH 454 临时认证故障）可重试，认证配置/证书/永久拒绝停止自动重试。部分收件人被接受时保留数量提示，停止自动重试以免重复发给已接受者。`fixture` 模式不创建 SMTP 连接，也不伪造 SENT；SENT 只表示服务器至少接受一个收件人，不能证明进入收件箱或已读。

Node 24.15.0 本地验收日志位于忽略提交的 `.local/email-test/`。主机默认 Node 20 的初步检查已由 Node 24 正式检查取代。回环模拟 SMTP 协议烟测使用临时 CA 和有效证书验证：隐式 TLS、STARTTLS 各捕获一封合成测试邮件；不支持 STARTTLS 的服务器被拒绝且未收到正文。该烟测无真实邮箱投递，收据为 `smtp-receipt.json`。用户已明确后端服务器更新由其自行执行。

- 冻结安装、API 契约生成、`typecheck`、`lint`、`format:check`、`build`、`security:check`、生产依赖 high 等级审计与 `git diff --check` 通过。
- `pnpm test`：16 个文件、128 项通过，覆盖 TLS 配置、Fixture 不创建传输、部分接受、空接受、暂时/永久错误、超时和敏感信息保护。
- 隔离真实 PostgreSQL 18 / Redis 7.4：70 项主集成、35 项历史流水线、62 项配置/API 检查和 86 项模式隔离断言通过。邮箱新增检查覆盖默认禁用、幂等补种、2525 端口、加密与密码保留、清除、非法字段及密钥轮换修复。
- Chromium E2E：14/14 通过，包含 SMTP 配置保存/重载、多收件人、密码不回显与草稿清除、Fixture 测试入队、390px 页面/弹窗无横向溢出。首次与源码写入并行的运行触发 API watch 重启，导致一个旧用例暂时连接失败；源码固定后完整重跑，无重试通过。

2026-11-04 09:35（Asia/Shanghai）发布验收：

- [Actions 41754198134](https://github.com/AmazingZ-sys/financial-radar/actions/runs/41754198134) 的 verify、release、API/Worker images、image-manifest 和 vercel 全部成功；云端 verify 包含生产 Compose 与浏览器验收。此前 `5ccfd3b` 的运行已在发布前取消，最终发布包含 AUTH 454 重试修复。
- [Release v1.2.0](https://github.com/AmazingZ-sys/financial-radar/releases/tag/v1.2.0) 对应 `fabccb65c22d84085b9fca7b83d8afd0870c4893`，`CHANGELOG.md`、`release-metadata.json` 与 `image-manifest.json` 已实际上传。API digest 为 `sha256:59e3205f407e9af24c17df1d41dd30280196c36371be631643742105f707b9d0`，Worker 为 `sha256:5890852f117793aab0ff1616c2d6c80dc500babd3e8ecbf00195d57712d578d7`；GHCR 远程 inspect 验证清单、linux/amd64、版本/revision 标签和运行环境与 Release 一致。
- Vercel production 部署状态为 success，对应同一完整 commit；[部署地址](https://financial-radar-4hztev4mz-amazings-projects-6f99eda0.vercel.app) 已生成。[正式域名](https://radar.amazingzsys.site) 的 `/login` 与 `/notifications` 均返回 HTTP 200 和相同 SPA HTML，实际入口与通知懒加载资源包含 SMTP 配置字段、正确生产 API 地址、安全响应头及 immutable 资源缓存。
- 只读线上核验收据保存在 `.local/email-test/{release-metadata,image-manifest,release-image-verification,deployment-status,frontend-production-receipt}.json`。本次没有操作用户后端服务器；发布前其 `/health` 返回 v1.1.1，镜像发布与静态页面核验不代表服务器已升级。

用户可在服务器执行 `sudo bash /opt/financial-radar/infra/scripts/deploy.sh --version v1.2.0` 更新 API/Worker，再到「通知中心 → SMTP 邮箱 → 配置渠道」保存配置、启用并测试。实际外部 SMTP 邮箱尚未配置或投递；模拟协议、Fixture 和服务器接受不能视为用户已收到邮件。

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
| 通知      | Telegram/飞书/Bark/SMTP邮箱，渠道测试、启停、重试、模板、冷却/时段、尝试审计                                 | Fixture永不外发；SENT只表示平台接受；响应丢失时不能保证第三方exactly-once或用户已读                      |
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
