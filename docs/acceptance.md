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

发布前未更新生产Worker，也未重置或删除生产cursor。当前Pump Program在每轮20笔、默认60秒轮询预算下不能承诺持续追平；高流量实时覆盖仍需有预算的索引/流式采集方案，不能以分页补偿验收替代。WTI保持日度参考价，黄金/原油是否生产恢复以服务器后续真实成功记录为准。

2026-11-04 15:42（Asia/Shanghai）发布验收：GitHub Actions [41793159484](https://github.com/AmazingZ-sys/financial-radar/actions/runs/41793159484) 的 verify、semantic-release、API/Worker 镜像、immutable image manifest 与 Vercel 全部成功。[Release v1.3.2](https://github.com/AmazingZ-sys/financial-radar/releases/tag/v1.3.2) 对应 `2b3dcbe6378d38162364f8374e69d7d98c562d58`；API 镜像摘要为 `sha256:df86ffce4a3bf2864779ad1cc2fd72b21a58999d6314aa412b14a2b80bcae48f`，Worker 镜像摘要为 `sha256:51827cf77675e81ae1127055ebe95b0218405b6d748649942a9c61cd1d9e5c99`。Vercel 发布成功，但本次没有操作后端服务器；后端仍需用户按 Release 执行部署脚本。该版本包含 `0003_source_pending_batches.sql`，部署脚本会在更新 API/Worker 前执行向前兼容迁移。只更新镜像不会同步宿主仓库中的诊断脚本；需要诊断时应检出对应 Release 文件后通过 stdin 传入容器。生产 Solana 补偿进度与黄金/原油恢复仍以服务器实际健康记录为准。

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

## AI 推理强度配置 · 2026-11-04

按 [25 可配置集成](25-configurable-integrations.md) 的新增设计实现：AI 配置可选择 Low / Medium / High / XHigh，默认 XHigh；旧数据库配置缺少字段时兼容为 XHigh。`AI_REASONING_EFFORT` 提供服务器初始默认，保存的数据库选择优先；无关 PATCH 不重置档位。后台分析发送保存的 `reasoning_effort`，缓存身份包含强度，运行记录保留实际值。连接测试固定 Low 且不修改分析配置，Fixture 仍跳过真实调用。测试输出上限从 32 调整到 512 tokens，为推理和短回答保留空间；截断空输出返回明确错误。

Node 24.15.0、pnpm 10.26.2，本地独立 PostgreSQL（55436）与 Redis（实际端口 56812，E2E 使用独立逻辑库）验证：

| 检查                                                         | 结果与证据                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`、`pnpm lint`                                | 全包与工具脚本通过；`.local/ai-reasoning/{typecheck,lint}.log`；连接测试最终修正后 API 类型检查另通过                                                                                                                                                                       |
| `pnpm test`                                                  | 21 个文件、203 项通过；`.local/ai-reasoning/unit.log`。最终 provider / 连接测试定向 14 项另通过，含各档序列化、缓存隔离、Low 请求、不修改保存值、Fixture 无出站及截断错误；`ai-contract.log`                                                                                |
| `pnpm test:integration`                                      | 70 项主检查、35 项历史、12 项 EVM、13 项交易版本、25 项 Solana 恢复、20 项商品恢复、41 项 UniSat、18 项来源配置、66 项配置/API、86 项模式隔离通过；`.local/ai-reasoning/integration.log`。包含旧 JSONB 默认、High 持久化与即时读取、非法值拒绝、部分更新保留和 Low 测试隔离 |
| `pnpm test:e2e`                                              | Chromium 19/19 通过；真实 API 保存 High / 刷新恢复 / 丢弃未保存值，以及明确标注 mock 的旧响应默认 XHigh、Low 测试不覆盖选择、390px 无溢出；`.local/ai-reasoning/e2e.log`                                                                                                    |
| `pnpm build`                                                 | 9 项构建任务全部通过；`.local/ai-reasoning/build.log`。连接测试最终修正后 API 编译另通过；`api-final-build.log`                                                                                                                                                             |
| `pnpm api:types`、`pnpm format:check`、`pnpm security:check` | 生成 OpenAPI / Web 类型、格式与凭据扫描通过；`.local/ai-reasoning/{api-types,format,security}.log`                                                                                                                                                                          |
| 视觉检查                                                     | 已查看真实本地配置页 1440px / 390px 截图，默认 XHigh、表单布局及 Low 提示可见，无横向溢出；`.local/ai-reasoning/ai-{desktop,mobile}.png`                                                                                                                                    |

首次集成检查因本地 Redis 测试启动器选择了其他端口而 readiness 失败，改用实际监听端口后完整重跑通过，未修改生产依赖保护。AI 请求验证使用合成传输与占位凭据，未使用真实供应商密钥或声称真实模型联通。本轮没有数据库结构迁移、提交推送或生产部署。

## 线上起步预警规则示例 · 2026-11-04

用户要求直接添加合理的规则示例，解决未添加规则的初始状态。通过用户已登录的线上控制台 `https://radar.amazingzsys.site/rules` 实际创建「基础监测 · 关键变化（示例）」v1；保存时页面显示 1 条规则、1 条已启用，时间为 16:39（Asia/Shanghai）。这是线上配置写入，未部署本地尚未发布的代码。

- 通知级别 P2；置信度至少 65%；机会评分下限 0、风险评分上限 100，用于研究提醒，不把低机会分的公告挡在门外，也不把未知项目认定为安全机会。
- 事件类型：`OFFICIAL_ANNOUNCEMENT`、`PROTOCOL_RELEASE`、`PRICE_ANOMALY`、`NEW_TOKEN_DEPLOYED`、`PAIR_CREATED`、`MINT_STARTED`、`PROJECT_LAUNCHED`、`PARTICIPATION_WINDOW_EXPIRING`。排除普通 `NEWS` 与周期快照；不添加资产、分类、已验证来源、增长或铸造进度限制。
- 检测窗口为首次发现后 3600 秒；同一规则/项目冷却 3600 秒（无项目时按事件），不是全局每小时一条的频率上限。绑定当前已配置并启用的 Telegram Bot、邮箱 SMTP 两个渠道；原通知偏好为最低 P2、未启用静默时段，未修改这些偏好。
- 规则页面的真实测试返回 `matched: true`、`全部配置条件满足`。此测试仅评估已有事件，不生成通知或验证本次渠道投递。创建规则不回推历史事件，后续新事件命中才进入通知链。风险事故应使用独立规则，避免和普通项目提醒共用冷却。

本轮仅更新线上规则配置与此记录；未修改业务代码，因此不重复执行编译及单测。验证截图位于 `.local/alert-rule-starter-enabled.png`、`.local/alert-rule-starter-test.png`；没有声称本次已收到消息、平台已接受本次新通知或用户已读。

## AI 推理强度发布准备 · 2026-11-04

用户明确授权提交代码、发布 Release，后端服务器由用户更新。发布前补齐新前端与旧 API 的兼容：按原始响应是否提供推理强度判断能力；旧后端下显示升级提示，禁用推理设置和连接测试，其他配置仍可保存且不提交新字段。新后端到位后刷新恢复完整功能，避免把前端补默认误当作服务器已保存 XHigh。操作指南见 [32 AI 推理强度版本更新](32-ai-reasoning-update.md)。

最终本地复验：Node 24.15.0 / pnpm 10.26.2，`typecheck`、`lint`、21 文件 204 项单测、9 项构建任务、20/20 Chromium E2E 与 `format:check` 全通过，日志 `.local/ai-reasoning-release/{typecheck,lint,unit,build,e2e,format}.log`。新增 E2E 用明确的旧后端测试桩验证严格拒绝新字段时仍能保存名称/模型、未发测试请求，模拟升级后恢复 High 与连接测试；真实 API 保存/刷新与其余页面回归也通过。后端逻辑未在本次兼容修正中改变，PostgreSQL/Redis 集成证据沿用上节已执行结果，云端工作流仍须完整复验。

此节记录发布准备与实际本地结果；云端发布状态以本轮 Actions、Release 资产及 Vercel 收据的后续核验为准，不据此声称已发布成功或服务器已更新。

## 2026-11-04 · AI 上游流式接收与超时修复

先更新 `10-ai-analysis.md`，再修改 Provider、安全 HTTPS 传输、连接测试和 Worker。原调用使用总计时 `AbortSignal.timeout(timeoutMs)`，且 HTTPS 传输缓冲完整响应；本轮改为 `stream: true`，按 SSE 增量接收并拼接正文。已有 `timeoutMs` 改为首包/连续无字节等待上限，每次收到字节续期；后台分析另设 10 分钟总上限，Low 连接测试总上限仍为 60 秒。完整 JSON 兼容响应只读取一次，不自动重发收费请求。

只有正常 `finish_reason: stop` 与 `[DONE]` 都到达、JSON/证据校验都通过才保存分析；中断、token 截断、无效编码、流内错误和超限不保存成功结果。支持跨块 UTF-8、CRLF、多行 SSE、注释心跳、reasoning 增量与最终用量块；reasoning 不混入正文，缺失用量保持未知。保留固定 DNS、私网/重定向拒绝、2MB 上限和底层连接取消；API 测试完成后保存已知 token 用量。

新增 AI 专属 `financial-radar-ai` 队列（并发 2），采集/通知保留原队列（并发 4）；旧队列分析按稳定 outbox ID 转交。状态页与心跳合并两队列计数。AI run/outbox 租约放宽为 15 分钟，执行前刷新 outbox 租约，重试刷新 run 租约并清理旧错误；通知保持短租约，`--once` 先处理通知。无需数据库结构迁移。

Node 24.15.0 / pnpm 10.26.2 实际验证，日志位于忽略提交的 `.local/ai-streaming/`：

| 验证                                                        | 结果                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --offline --ignore-scripts` | 通过，只增加 API 对已有 AI workspace 包的依赖，无外部版本更新                                                                                                                                                     |
| `pnpm typecheck`、`pnpm lint`                               | 全包及工具脚本通过；`typecheck.log`、`lint.log`                                                                                                                                                                   |
| `pnpm test`                                                 | 23 文件、234 项通过；`unit.log`，覆盖持续输出超过空闲时间、首包/中途空闲/总时长取消、断流/截断拒绝、usage、脱敏及队列隔离                                                                                         |
| `pnpm build`                                                | 9 项构建任务通过；`build.log`                                                                                                                                                                                     |
| `pnpm test:integration`                                     | 独立 PostgreSQL（55446）/Redis（56446）通过；新增 AI 恢复 14 项，主流程 70、历史 35、EVM 12、交易版本 13、Solana 恢复 25、商品恢复 20、UniSat 41、来源配置 18、配置/API 66、模式隔离 86 项通过；`integration.log` |
| `pnpm test:e2e`                                             | Chromium 20/20 通过；真实本地 API 配置读写、旧后端兼容和桌面/移动回归；`e2e.log`                                                                                                                                  |
| `pnpm security:check`                                       | 凭据/eval 扫描通过；`security.log`，未执行依赖漏洞审计                                                                                                                                                            |
| 本地真实 HTTP SSE 长流                                      | 使用回环模拟上游与真实 Node fetch，持续约 65 秒（64920ms）、空闲阈值 60 秒；单次请求完整拼接并通过证据校验，无真实模型调用。`long-stream.{ts,log,json}`                                                           |
| `pnpm format:check`、`git diff --check`                     | 通过；`format.log`                                                                                                                                                                                                |

边界：未调用真实付费 AI、未测试真实中转服务能力、未发布或修改线上配置。上游在首包前完全无字节超过配置值时仍会超时；现有分析 1000 token 输出上限保留，达到上限会明确失败。进程仍沿用 30 秒退出上限及部署停止宽限，重启可能中断在途长流，之后依靠持久租约恢复，不能承诺同一次生成续传或不再次计费。

## v1.4.1 AI 流式修复发布核验 · 2026-11-04

用户授权提交、推送并发布 Release，后端服务器由用户更新。修复提交 `62045b3f1e779a41c28429e2d68fdfdd080f0ce6` 已推送 `codex/ai-streaming-release` 与 main，触发 [Actions 41849399736](https://github.com/AmazingZ-sys/financial-radar/actions/runs/41849399736)。verify、release、API image、Worker image、image-manifest 和 Vercel 全部成功；verify 包含契约生成、typecheck、lint、格式、234 项单测、真实 PostgreSQL/Redis 集成、构建、运行时语法、隔离生产 Compose、安全扫描、高危依赖审计与 20 项浏览器回归。

- [v1.4.1 Release](https://github.com/AmazingZ-sys/financial-radar/releases/tag/v1.4.1) 的实际 tag、`release-metadata.json` 和 `image-manifest.json` 的版本、完整 SHA 一致，三个 Release 资产（含累计 CHANGELOG）均已上传。
- API 镜像 digest 为 `sha256:3009dd08d9407f07a34f0c4863b39cc25a426e51d7ec771bdd2ef0cf71e8d003`；Worker 为 `sha256:68bb7c789a66372fa6cf6673311f75286337df5c51056c54716485938b055267`。远端版本 tag 与 SHA tag 均匹配清单；两者均存在 linux/amd64 manifest，镜像 label、版本/SHA 环境、Node 24.22.2 和非 root `node` 用户已只读核对，没有拉镜像层或运行生产容器。
- Vercel 部署收据为 [financial-radar-b9fwdvzfp-amazings-projects-6f99eda0.vercel.app](https://financial-radar-b9fwdvzfp-amazings-projects-6f99eda0.vercel.app)，版本/SHA 与 Release 一致。正式站点 `/login`、`/system`、入口 JS、新 SystemPage chunk、favicon 全部 HTTP 200；新入口为 `/assets/index-DxQq62NY.js`，已包含首包/空闲超时说明，静态 API 前缀、安全头与不可变资源缓存符合配置。
- 发布前后公开健康检查均为后端 v1.4.0，`/ready=200`；没有登录、修改线上配置或发起真实 AI 调用。新流式与超时策略需用户更新 API/Worker 后生效，更新命令见 [33 流式版本更新](33-ai-streaming-update.md)。

实际收据保存在忽略提交的 `.local/ai-streaming-release/`：`baseline.json`、`v1.4.1/{actions,release,git-tag,release-metadata,image-manifest,verification-summary}.json`、镜像 manifest/config、`vercel-v1.4.1/vercel-deployment.json` 与 `http-verification.json`。首次 SSH 推送连接失败后以现有 GitHub 登录凭据通过 HTTPS 成功推送；首次 Vercel artifact 下载网络 EOF，经有界重试成功读取，不以中间失败冒充发布失败或验收成功。

## 2026-11-05 · 候选优先分析与积压止血

先完成 [34 候选优先分析](34-candidate-first-analysis.md) 设计，再修改实现。排查确认所有新事件只要 AI 已配置就入队；UniSat 状态变化和 ETH 新池因此逐条付费分析。既有示例规则同时包含新池/部署/mint，且冷却按项目，造成额外通知。现有系统没有 X/KOL connector 或主题聚类；本轮没有把新闻列表声称为社交热点发现。

live 入队和执行均复查一小时有效期、已验证高可信重要公告/已确认严重风险准入；普通新闻、新池、mint 和快照记录 SKIPPED 与原因。事务内限制候选20条和同资产6小时冷却；输入证据最多5条、每条2400字符、正文合计8000字符；每日真实调用默认最多20次（重试计入），金额/次数不足终止候选，不延期至次日。通知独立优先派发，live 分析同时最多派发2条；分批结束不合格历史 outbox，Redis 遗留任务消费时仍复查。保留全部原始事实、已完成分析和用量账目，运行中请求受保护。

新增同事件运行中/已完成保护，避免配置或证据改变造成旧任务重复收费；清理先锁事件，再查询运行状态，防止在途预留事务提交前的旧快照覆盖运行状态。跳过时合并决策元数据保留冷却。规则 `includeRoutineEvents` 默认关闭，界面可显式选择；规则测试与实际通知同判定，严重风险仍须遵守规则其他条件。事件详情显示跳过原因，不把跳过显示为已分析。

Node 24.15.0 / pnpm 10.26.2，隔离 PostgreSQL 55456 / Redis 56456（最终集成使用独立逻辑库1）实际结果，日志位于忽略提交的 `.local/ai-candidates/`：

| 验证                                                                             | 实际结果                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`、`pnpm lint`                                                    | 全包和工具通过；`typecheck.log`、`lint.log`                                                                                                                               |
| `pnpm test`                                                                      | 24文件285项通过；含准入/时效、模式隔离、严重风险例外、输入上限与默认通知过滤；`unit.log`                                                                                  |
| `pnpm build`                                                                     | 9项构建任务通过；`build.log`                                                                                                                                              |
| `pnpm test:integration`                                                          | 主流程70、历史35、EVM12、交易版本13、Solana恢复25、商品20、UniSat41、来源配置18、配置/API66、AI恢复14、候选准入27、模式隔离86项通过；`integration.log`                    |
| 新增真实数据库检查                                                               | 并发同资产只入队1条、全局候选上限20、100多条旧分析不阻塞通知、并发派发最多2条、旧任务零供应商调用、预算0不跨日积压、已完成/在途保护、清理与预留行锁竞争、跳过后冷却仍保留 |
| `pnpm test:e2e`                                                                  | Chromium 22/22通过；含明确标注 mock 的过期说明/原始证据，以及真实API的规则开关保存/取消/刷新恢复；`e2e.log`                                                               |
| `pnpm api:types`、`pnpm format:check`、`pnpm security:check`、`git diff --check` | 契约生成、格式、已知凭据/eval扫描与补丁空白检查通过；`format.log`、`security.log`；未进行依赖漏洞审计                                                                     |

首轮 typecheck 发现新增工具脚本直接引用非根依赖 postgres 类型，改为从 sql.json 参数推导后通过。复验曾与浏览器测试共用 Redis 限流计数而触发429；改用独立测试逻辑库完整重跑通过，没有降低应用限流。此前失败日志保留为 `integration-rate-limit.log`。

边界：没有付费模型调用、真实社交采集、线上配置修改、队列清理、提交推送或发布。线上上万条积压仍需部署新 Worker 后由真实任务复查与恢复器处理；已向供应商发出的请求无法撤回费用。旧通知记录不会被伪称为取消或已读。X 热点聚合、研究候选和 AI 研究结论驱动的外发工作流为后续建设，须使用实际授权来源验证，不能据此声称已上线。

## 2026-11-05 · 管理页 AI 日上限与免费自建 X 讨论采集

设计先于业务实现：先35管理配置设计；用户后续明确采集预算为0并接受自建使用自己授权的X登录态，最终以 [36 免费X采集](36-free-x-collection.md) 覆盖官方API方案。未购买数据服务、未调用官方/第三方付费数据API，未使用真实X登录态或付费模型。

AI管理页可保存0..500次/UTC日（默认20），后续请求读取数据库有效配置；连接测试和重试共享调用额度，系统状态按真实预留尝试计数。保留旧后端能力检测，旧存储回退环境默认。X管理页提供服务器部署步骤、auth_token/ct0登录态保存/清除、账号与关键词、采集间隔、本地每日请求上限（默认96）、原创作者门槛、调试样本与实际错误；登录态加密保存、不回显或持久化到浏览器。旧官方Bearer凭据及旧测试成功记录不转换为免费采集成功。

新增内部twscrape0.20.1容器与可选Compose x-free profile；业务连接器仅访问服务器配置的内部采集服务，固定窗口和严格递减分页，批次先持久化再推进游标。关闭代理、跳转、遥测、原始错误日志/诊断转储及付费回退；单授权会话临时SQLite用后删除，限流冷却与登录失效明确显示。验证并修正实际依赖的静默中断、解析跳过、嵌套引用帖被计为额外作者、缺少预期限流头时的错误分类；26项采集器测试使用实际安装的固定依赖与模拟传输。

单帖只保存UNVERIFIED/P3原始证据，不受通用规则opt-in影响，也不逐条分析；多作者且多原创正文的主题才形成UNVERIFIED/P2研究候选，同主题6小时冷却，受全局AI上限与时效约束。只在AI完成后按P2/P3规则产生研究提醒；提醒不代表发现可投资机会或完成链上风险确认。AI完成先提交，通知阶段故障不回滚付费结果，重放仅恢复通知。X聚合故障单独隔离，不阻塞确定性告警。

Node24.15.0 / pnpm10.26.2，隔离PostgreSQL55466 / Redis56466（集成独立逻辑库1、E2E逻辑库0）实际结果，日志位于忽略提交的 `.local/managed-x/`：

| 验证                    | 实际结果                                                                                                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typecheck、lint、build  | 全包/工具类型检查、ESLint通过；9项构建任务通过。最终工具类型检查再次通过。`typecheck.log`、`tools-typecheck.log`、`lint.log`、`build.log`                                                                                                                            |
| pnpm test               | 27文件398项通过，含X连接器42项、Cookie/环境约束、讨论聚合与AI准入。`unit.log`                                                                                                                                                                                        |
| pnpm test:integration   | 主流程70、历史35、EVM12、Solana交易版本13、Solana恢复25、商品20、UniSat41、来源配置18、配置/API66、AI流式恢复14、候选准入27、X管理45、X主题17、X通知恢复8、模式隔离86，共497项检查通过。`integration.log`                                                            |
| pnpm test:e2e           | Chromium25/25通过，新增管理页3项；真实本地API保存/重载、AI0/37、Cookie不回显/不存浏览器、清除停用、Fixture跳过、旧后端兼容。最终多行输入样式调整后管理页3项复验通过，1440/390截图人工查看无横向溢出。`e2e.log`、`managed-x-e2e.log`、`x-desktop.png`、`x-mobile.png` |
| 采集器构建/隔离测试     | Docker镜像构建通过；Python3.13非root/只读文件系统、临时tmpfs、network none下26/26测试通过，覆盖真实依赖接口、临时会话清理、HTTP鉴权、超时、限流、分页、解析中断与引用作者隔离。`collector-build.log`、`collector-tests.log`                                          |
| 契约/格式/安全/部署配置 | API契约生成、Prettier、已知凭据/eval扫描、git diff空白检查通过；生产/开发Compose含x-free profile可解析。未执行完整生产Compose四服务重验或依赖漏洞审计。`api-types.log`、`format.log`、`security.log`                                                                 |

集成首轮的模式隔离用例仍按运行记录条数断言live调用数，已改为以既有用量为基线，单条合成live运行放入两次预留，验证fixture按运行数、live按尝试数（含重试）计数，然后完整重跑497项通过。最初单测发现X窗口小数与规范化关键词顺序问题，分别补整数校验和规范化预期后通过；最终格式检查修正工具用例格式后通过。

边界：本地改动未提交、推送、发布或部署；未修改线上配置、清理线上队列或读取真实X会话。免费指不增加第三方数据API/AI抽取费用，仍使用已有服务器资源，不承诺全量、持续在线或实时覆盖。真实X联通、账号可见范围和上游网页接口稳定性仍需部署后在管理页实测。线上积压须更新API、Worker与前端后由持久任务恢复流程处理；已发送给供应商的AI调用不能撤销费用。

## 2026-11-05 · X 采集随机区间与持久调度

先完成 [37 X采集随机间隔](37-x-random-polling.md) 设计，再修改配置、数据库请求门禁、Worker和管理页。管理页提供最短/最长采集间隔（整数300..86400秒），新配置默认600..1200秒；保存并刷新后保留。旧单值配置按原值到1.5倍读取，上限86400秒，不在读取时改写旧记录；支持部分更新并拒绝反转区间和混用新旧字段。数据源页面引导至系统管理，通用来源PATCH拒绝修改X启停或固定间隔，避免配置同步后覆盖用户操作；初始化保留随机区间标签。

每次真实采集器请求前，在同一PostgreSQL配置锁内校验配置、额度及时间，随机抽取闭区间内的下一次间隔，并同时持久化请求次数和请求时刻。手动连接测试共用门禁，未到时间返回skipped且不计次。保存配置、重启、重复任务或Redis任务丢失不重抽间隔、不提前请求；限流冷却只延长门禁，缺少有效冷却值时等待15分钟。已持久化批次可恢复处理，不因此发起新的采集器请求。

Worker移除X的固定周期scheduler，改用协调器根据PostgreSQL允许时刻投递一次性延迟任务；每日额度耗尽等到UTC次日，关闭或未配置时不投递。管理页展示已保存区间、下一次允许请求和最近抽取间隔。一次采集任务仍可能产生分页等多次上游HTTP请求，区间和本地次数按采集器任务计，不等于逐条X HTTP计数；随机间隔不能保证避免账号限制。

Node24.15.0 / pnpm10.26.2，隔离PostgreSQL55466 / Redis56466（集成逻辑库1、浏览器逻辑库0）实际结果，日志位于忽略提交的 `.local/managed-x-interval/`：

| 验证                                        | 实际结果                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`、`pnpm lint`、`pnpm build` | 最终全包/工具检查通过，9项构建任务成功；`typecheck-final.log`、`lint-final.log`、`build-final.log`。                                                                                                                                                                        |
| `pnpm test`                                 | 28文件405项通过；包含区间上下界、反转/非整数、旧值转换、冷却只延长和随机状态；`unit-final.log`。                                                                                                                                                                            |
| `pnpm test:integration`                     | 原有流程与X管理50项、随机调度72项等共574项通过；实际PostgreSQL/Redis验证8个并发预留仅1个通过、32次随机抽样、手动测试共享门禁、冷却镜像、配置保存不重置、丢失队列任务恢复、BullMQ去重、UTC额度、Fixture隔离，以及通用来源PATCH拒绝X修改且状态不变；`integration-final.log`。 |
| `pnpm test:e2e`                             | Chromium27/27通过，含区间600..900保存/重载、901..900在提交前拒绝、PATCH不携带旧单值、明确标注模拟响应的调度时间展示和X来源管理跳转；`e2e-final.log`。1440/390截图已查看，区间、调度及按钮布局无横向溢出；`.local/managed-x/x-desktop.png`、`x-mobile.png`。                 |
| 契约、格式、安全                            | `pnpm api:types`、`pnpm format:check`、`pnpm security:check`和`git diff --check`通过；`api-types.log`、`format-final.log`、`security-final.log`。安全检查为已知凭据/eval扫描，未运行依赖漏洞审计。                                                                          |

边界：未访问真实X、未使用真实登录态或付费模型，未提交、推送或部署，未修改线上设置或清理线上队列。本轮未改Python采集器运行逻辑，前一节的26项隔离测试未重复运行；上线后仍需以实际授权会话验证采集可用性。

## 2026-11-05 · 机会通知降噪

先完成 [38 机会通知降噪](38-opportunity-notifications.md) 设计，再实现统一通知准入。普通 ETH 新交易对、BRC20 部署/普通 mint、链上状态快照只保存观察事实；即使旧规则设置 `includeRoutineEvents=true` 也不能外发。其他链上机会还须满足已核验来源、置信度至少80%、机会分至少65、独立风险分至多60、EARLY_STAGE/ACTIVE 阶段和已核验且有说明的参与条件。结构化严重风险保留独立通道，不等待 AI；用户规则仍可继续收紧。

发送前会重新读取持久化事件和当前规则。PENDING/RETRYING 的旧自动通知若已停用、移除渠道或不再满足准入，会转为 CANCELLED，并保留复查原因和尝试记录；SENT 历史不改写，未绑定事件的手动渠道测试不受机会门槛影响。没有数据库结构迁移、Redis 清理或真实平台发送。

通过线上已登录控制台修改「基础监测 · 关键变化（示例）」：规则现为「机会精选 · 已核验参与信号」v2，置信度80%、机会分65、风险60、仅已验证来源、EARLY_STAGE/ACTIVE、参与/增长/流动性/启动信号白名单、同项目冷却86400秒；另新增「安全风险 · 严重流动性撤出」P1 独立规则，风险上限100、事件类型 `LIQUIDITY_REMOVED`，保留两个已配置渠道。规则测试对当前普通事件返回 `matched:false`，原因包含事件类型、阶段、来源、置信度和机会评分不满足；页面截图保存于 `.local/opportunity-notifications/live-rule.png`。该线上写入已完成，代码保护仍需部署 API/Worker 后才会清理服务器存量队列。

Node24.15.0 / pnpm10.26.2。隔离 PostgreSQL55466 / Redis56466 实际结果，日志位于忽略提交的 `.local/opportunity-notifications/`：

| 验证                                                             | 实际结果                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm format:check` | 通过；9 个构建任务成功。                                                                        |
| `pnpm test`                                                      | 28 个文件、432 项通过。                                                                         |
| `pnpm test:integration`                                          | 隔离数据库/Redis 共 70 项主检查通过；含通知策略 24 项、历史35项和模式隔离86项；无外部平台发送。 |
| 相关 Playwright E2E                                              | Chromium 12/12 通过，覆盖新规则默认门槛、行情快照 opt-in 不放开链上通知及规则持久化。           |

边界：本地代码尚未提交、推送或部署；线上旧 PENDING/RETRYING 记录需更新 Worker 后由复查逻辑处理，已发出的邮件无法撤回。机会准入只减少噪声，不保证任何收益或安全性。

## 2026-11-05 · 通知降噪发布门禁修复

用户授权提交、推送并发布 Release，后端由用户更新。功能提交 `6bb1d71e2e9c3405c996f6166eca88f2caeed183` 已推送分支和 main；首次 [Actions 41982386831](https://github.com/AmazingZ-sys/financial-radar/actions/runs/41982386831) 的类型、lint、432项单测、集成、构建、采集器隔离测试、生产Compose、安全扫描与依赖审计通过，但完整E2E有两项失败，未产生Release。

使用GitHub连接器读取失败日志及上传trace，确认AI配置PATCH、X连接测试POST返回429：CI集成与E2E复用了Redis限流计数。E2E步骤改为独立逻辑库1，保留应用限流与安全校验。另修复评分编辑测试中重复成功toast的严格选择器，并对两次PATCH的HTTP200、响应版本/权重以及刷新后的持久结果逐项断言，避免旧toast造成提前通过。

Node24.15.0 / pnpm10.26.2；本地隔离PostgreSQL55466，集成Redis逻辑库6、E2E逻辑库7，先执行完整集成保留明确标记的Fixture种子，再执行浏览器测试。typecheck、lint、432项单测、9项构建全部通过；集成主流程70项及通知24项、历史35项、模式隔离86项等全部通过；完整Chromium 27/27一次通过。收据在忽略提交的 `.local/release-41982386831/`，日志以 `*-resume.log` 命名。此前空库仅迁移未采集导致缺失事件/项目，复用Redis又触发登录限流的失败均保留，没有因此放宽业务限制。实际Release与镜像发布结果待后续追加。
