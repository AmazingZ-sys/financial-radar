# 03 数据源调研与接入决策

调研日期：2026-11-02。核验依据为下列官方文档页面，网页可读不等于已完成生产端到端连接测试；测试结果另外记录于验收记录。本文是数据采集实现之前的设计基线。额度会变化，以服务响应头、账户控制台及合同为准。未确认的字段明确为未知。

## 1. 接入原则

- 只使用正式 API、官方 RSS、自己有权访问的节点和经授权 Webhook；不依赖未公开 CMS 接口、不绕过登录或封禁。
- 每条数据保留来源、原始响应、来源时间、系统观察时间和模式 `live | fixture`；Fixture 与生产来源不得混成实时统计。
- 公开接口不等于允许商业再分发。默认单管理员私有研究部署；公开平台启用前逐项复核许可。
- `pollInterval` 是系统轮询配置，不是来源更新周期或延迟保证。没有来源时间戳时保留 null，不用采集时间伪装。
- 来源切换生成新的 sourceId，并保留原始供应商标识；禁止将来自不同市场、时段、单位的数据无提示拼接。

## 2. 官方来源与能力矩阵

| 来源                     | 数据与接口                                          | 鉴权/费用                                 | 限流与更新                                                                   | 历史与延迟                                                                  | 可靠性/替代                                                   | 商用与 MVP 决策                                                                                   |
| ------------------------ | --------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Binance Spot             | REST ticker/candles、市场 WS                        | 公共行情无需交易密钥；具体商业方案需确认  | 按 IP 请求权重，exchangeInfo 与响应头为准；429/418 退避                      | Kline/归档可提供历史；行情时间戳可用，端到端 SLA 未确认                     | 有地域限制；失败可切有权使用的 Coinbase，不能拼接同一资产历史 | 限私有研究，商业展示需核验协议；二阶段可选行情 provider                                           |
| Binance 公告             | 官方宣布有英文公告 WS                               | 连接鉴权、授权与额度需在对应文档/账户复核 | 公告驱动；本次未完成可执行 WS 契约核验                                       | 重放/补拉覆盖未知，不能保证完整历史                                         | 断线保留缺口并人工补录官方公告                                | 暂不启用生产连接；不把上市公告视为链上首次发现                                                    |
| Coinbase Exchange        | GET /products/{product_id}/ticker，candles，WS      | 公共 ticker 无密钥；不调用交易接口        | 当前 Exchange 文档：10 req/s/IP、burst 15；旧 Pro FAQ 不适用                 | tick 带 time；历史 candle 需分段与缺口处理；无延迟 SLA                      | 公共无 SLA；失败保留最后值并标记 stale                        | 市场数据许可限制个人/实体内部研究；MVP 私有模式 live，公开分发前书面许可                          |
| Coinbase 官方公告        | 官方博客、@CoinbaseAssets                           | X 需正式 API 授权；不抓取登录内容         | 2026-10-14 官方确认资产公告使用 @CoinbaseAssets                              | 博客并非上市完整历史；X 历史取决授权                                        | 人工官方 URL 证据或合法授权新闻供应商                         | 不宣称博客 RSS 等于全部上市；后续接入                                                             |
| DEX Screener             | token-pairs、tokens、搜索、最新 profiles/boosts     | 文档开放 API，合同可另有付费方案          | profiles/boosts 60/min；pairs/search/token 接口 300/min                      | pairCreatedAt 可缺失；历史逐笔/全量新池扫描不在本次确认能力内；延迟未知     | 自建/授权 DEX factory 事件索引替代                            | 商业使用受条款约束、不得未经授权转售 API；MVP 只跟踪已知 token/pair，广告热度不能证明可信         |
| UniSat                   | BRC-20 status、minted/holders 信息、Runes 索引 API  | Bearer key；额度按获批计划，未知          | status 可按 deploy 排序分页；具体免费额度/延迟未知                           | 有当前索引；历史快照及最初观察时间不得假定存在                              | 自建 Bitcoin Core + ord + BRC20 状态索引；跨供应商对账        | 获权后启用；无 key 默认禁用、Fixture 验证 deploy/mint 流程                                        |
| ord 自建                 | inscriptions、runes/rune JSON API                   | 自有节点无需 SaaS key；机器/存储/同步成本 | 块驱动；受节点索引速度制约                                                   | Runes 需 --index-runes；重建成本高；ord 本身不等于 BRC20 余额共识索引       | 与 UniSat 双源比对；需要重组回滚策略                          | 延后全节点运维，保留 adapter；不把铭文列表声明为全 BRC20 检测                                     |
| Ethereum JSON-RPC / Geth | eth_getLogs、block/receipt、eth_subscribe           | 节点自建或 Alchemy 等授权 RPC key         | 限流、历史日志跨度由 provider 决定；Alchemy 使用 CU 计量，套餐数字不固化     | HTTP logs 可按块补拉，WS 不是持久队列；需最终性/重组处理                    | 双 RPC 对账；保存 blockHash + logIndex                        | MVP 对特定 factory/合约范围设计，未声称覆盖全部新部署                                             |
| Solana RPC / Helius      | RPC logsSubscribe、getTransaction、授权增强 Webhook | 私有 RPC/Helius key，套餐付费与额度需确认 | 公共 RPC 文档列 100/10s/IP、单方法40/10s，且说明可能变化，不供生产依赖       | commitment 区分 processed/confirmed/finalized；重连 HTTP 补偿，历史取决节点 | 授权私有 RPC 与持久 checkpoint；避免公共端点作为生产底座      | 先限定 program/mint watch 范围，Fixture 测试；全链流量需预算                                      |
| Federal Reserve          | 官方 press_all.xml / press_monetary.xml RSS         | 无 key；公开官方 RSS                      | 未发布固定频率额度；建议本系统 60s 拉取、ETag/Last-Modified                  | RSS 窗口有限，历史公告需官方 archive；无秒级 SLA                            | 官方年度 press release archive，延迟报警                      | MVP live 经济政策新闻；保留标题、摘要、URL，第三方转载内容另核验                                  |
| FRED / ALFRED            | v1 series observations；v2 release bulk；vintage    | key 必需；个人 key/应用适用性需按条款核验 | 本次未确认固定请求额度；日/月数据按 release 更新                             | vintage 支持历史知情时点；日度美债不是实时行情                              | 直连原始 Treasury/BLS/EIA                                     | **默认禁用**：最新 legal API 条款 (k) AI 相关使用、(l) 存储缓存数据库限制与本项目冲突；待书面授权 |
| BLS                      | 官方 Public Data API、发布日期/经济日历             | v1 无注册，v2 需年度注册 key              | 未注册25查询/日，25序列/请求、10年；注册500/日，50序列、20年；两者50请求/10s | CPI/就业等按发布频率；可能修订，当前序列不能冒充当年初值                    | 发布稿/文件作为官方来源，FRED 不作为默认替代                  | 可选 provider；日历只填官方时间，市场预期值无来源即 null                                          |
| U.S. Treasury            | 日度利率 XML、按年/月/页获取                        | 无 key                                    | 日度，不是债券实时交易价；额度未公布，建议15min/日采集策略                   | par curve 可追至1990；日期不是精确公开时间；2Y/10Y/30Y 与真实利率可分别记录 | 官方 CSV archive；当日未发布显示最后数据日期                  | MVP 可选 live 日度债券源；原始 XML 不认识的新字段应兼容                                           |
| TreasuryDirect           | 拍卖公告/结果、历史查询与下载                       | 公开页面；本次未确认稳定承诺的 JSON API   | 拍卖发布驱动，额度/程序 API SLA 未知                                         | 官网页称一般证券结果可追至1998-07-27，TIPS1997；时点需原稿                  | 官方 press releases，人工导入                                 | 二阶段，不依赖未确认 TA_WS 路径                                                                   |
| EIA                      | API v2、bulk、石油库存/能源序列                     | API需注册 key；bulk 无需 key              | FAQ 建议持续低于约9000/h、突发<5/s，非硬 SLA                                 | 周度库存 API 可在发布后两小时内更新，不能宣传10:30即刻可取；series 分页     | 官方信息发布服务器 ir.eia.gov 与 bulk；需单独契约             | 可选官方油价/库存 provider；WTI/Brent 数据频率必须标明，非交易所实时报价                          |
| OPEC                     | 官网 press releases / 官方报告                      | 公开可读不等于再分发许可                  | 页面发布驱动，无确认稳定 API/配额                                            | 旧 press_room URL 已重定向首页，不能沿用旧地址承诺采集                      | 授权新闻渠道或人工官方链接                                    | 暂留人工证据入口，HTML collector 待核验授权和新结构                                               |
| GitHub releases          | GET /repos/{owner}/{repo}/releases，官方仓库白名单  | 公共无需 token；token 提高额度            | 未认证60/h/IP，通常认证5000/h；headers 权威、secondary limit另算             | list 分页；published_at 是可见时间；draft/private 不可采                    | ETag 条件请求、官方 release Atom 需复核；tag 不能等同 release | MVP live 跟踪白名单协议仓库；repo 归属需人工验证，正文许可按项目处理                              |
| 黄金/美元指数授权商      | MarketProvider 插件                                 | 无通用免费授权实时方案                    | 交易时段/延迟/配额均由合同确定                                               | 历史与现货/期货定义不同                                                     | FRED 不作为默认缓存回退；暂无授权就显示 unavailable           | 首版接口+Fixture，禁止虚构现货价格或把ETF作为黄金现货                                             |
| 合法 RSS/新闻            | 仅管理员审核的官方 feed 白名单                      | 各站条款不同                              | 依据 cache header、robots 和服务条款；本系统最少60s                          | RSS常不含完整历史、全文不应自动复制                                         | 来源官方 archive；不绕过 paywall                              | Fed 初始支持，其他按授权后注册 connector                                                          |

## 3. 官方资料索引

以上限流与能力来自以下页面；无可证明条款的商用/再分发权按未确认处理。

- Binance：[REST 与权重/退避](https://developers.binance.com/en/docs/products/spot/rest-api)、[公告 WS 官方声明](https://www.binance.com/en/support/announcement/detail/a72645c63e4a4062b77db52b86fef1bb)、[仅依赖正式文档接口原则](https://developers.binance.com/en/docs/introduction)。
- Coinbase：[ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker)、[当前 Exchange 限流](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits)、[2026资产公告渠道更新](https://www.coinbase.com/en-ca/blog/update-to-our-asset-listings-announcements)、[市场数据条款](https://www.coinbase.com/legal/market_data)。
- DEX：[API](https://docs.dexscreener.com/api/reference)、[条款](https://docs.dexscreener.com/api/api-terms-and-conditions)。
- Bitcoin：[UniSat BRC20 status](https://docs.unisat.io/developer-support/open-api-documentation/api-for-bitcoin/brc-20/get-brc-20-status)、[UniSat API](https://unisat.io/open-api)、[ord API](https://docs.ordinals.com/guides/api)、[BRC20 原始实验文档](https://domo-2.gitbook.io/brc-20-experiment)。
- EVM：[JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/)、[Geth订阅](https://geth.ethereum.org/docs/interacting-with-geth/rpc/pubsub)、[Alchemy throughput](https://www.alchemy.com/docs/reference/throughput)。
- Solana：[RPC](https://solana.com/docs/rpc)、[public RPC限制](https://solana.com/docs/references/clusters)、[provider选择与补偿](https://solana.com/docs/rpc/providers)、[Helius Webhook](https://www.helius.dev/docs/webhooks)。
- Federal Reserve：[RSS目录](https://www.federalreserve.gov/feeds/feeds.htm)、[2026 FOMC archive](https://www.federalreserve.gov/newsevents/pressreleases/2026-press-fomc.htm)。
- FRED：[API](https://fred.stlouisfed.org/docs/api/fred/)、[observations/vintage](https://fred.stlouisfed.org/docs/api/fred/series_observations.html)、[当前法律条款](https://fred.stlouisfed.org/legal/)。
- BLS：[API FAQ与额度](https://www.bls.gov/developers/api_FAQs.htm)。
- Treasury：[XML API](https://home.treasury.gov/treasury-daily-interest-rate-xml-feed)、[字段变化公告](https://home.treasury.gov/developer-notice-xml-changes)、[拍卖结果](https://treasurydirect.gov/auctions/announcements-data-results/announcement-results-press-releases/auction-results/)。
- EIA：[Open Data](https://www.eia.gov/opendata/)、[FAQ/延迟与额度建议](https://www.eia.gov/opendata/faqs.php)、[key/使用条款](https://www.eia.gov/opendata/register.php)。
- OPEC：[当前官网](https://www.opec.org/)。
- GitHub：[releases](https://docs.github.com/en/rest/releases/releases)、[限流](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[条件请求](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)。

## 4. Connector 运行契约

`SourceMetadata`：id、name、officialUrl、transport、mode、enabled、categories、licenseStatus、trust、pollInterval、freshnessTarget。`CapabilityDescriptor` 声明 supportsHistory / checkpoint / timestamp / streaming / scope，scope 包括 watchlist / factory / partial / full，默认为 partial，不通过名称隐含全量覆盖。

`RateLimitPolicy`：maximum、windowMs、burst、respectRetryAfter；未知配额用保守本地上限且不标为来源配额。`Cursor` 在 PostgreSQL source_checkpoints 持久化，只有原始数据成功入库才前进；包含 externalId / publishedAt / blockHeight / blockHash / page / etag 按来源使用。Redis 锁防并发重复拉取。

统一生命周期：initialize → fetch(cursor) / subscribe(onItem) → normalize(raw) → healthCheck → shutdown。Pull 返回原始 item + 下一 cursor；Streaming 重连后必须补拉；Webhook 先校验签名/时间戳/重放ID再落库，未经鉴权不得入管道。

错误分类：AUTH（禁用并提示配置）、RATE_LIMIT（尊重 Retry-After）、TRANSIENT（指数退避+jitter）、SCHEMA（隔离原始响应并报警）、PERMANENT（停止热重试）。每次请求 timeout；有限重试；连续失败熔断，半开探测；失败不返回伪造成功数据。健康检查区分可访问、数据新鲜、配置完成、quota unknown。

## 5. 预期时效与范围

本地目标（待真实测量）：Fed RSS 轮询60s、GitHub 未认证单仓300s、Coinbase ticker60s、已知 DEX token60s。延迟分解 sourcePublishedAt→firstSeenAt→detectedAt→queuedAt→platformAcceptedAt。来源没有精确公开时刻时发现延迟为 unknown。Treasury/BLS/EIA按日/月/周标记；不承诺秒级经济消息。P50/P95只统计具有完整时间链的真实样本，Fixture 单独标记。

### 当前配置与有界采样

- GitHub：`GITHUB_REPOSITORIES` 最多20个管理员核验的 `owner/repo`，每仓库独立Connector/checkpoint；默认 `ordinals/ord` 保留兼容sourceId，新增仓库ID含owner/repo。删去的配置保留历史证据并停止调度，不以一个默认仓库冒充白名单覆盖。
- DEX：`DEX_CHAIN` + `DEX_TOKEN_ADDRESSES` 最多30个已知token地址，链与地址格式同时校验。当前采集流动性快照；没有地址则未配置，非全链部署/新资产发现。
- UniSat：按部署排序读取完成/未完成分组的首尾页，选最近50条未完成、20条已完成候选，仅接纳近7天且有效的部署时间；状态不变不重复入库，持久checkpoint恢复状态指纹及批次身份。不能保证捕获所有完成跳变或长期跟踪离开窗口的项目。稳定资产标识关联项目；`deployTime/deployBlocktime` 只代表链上发生时间，来源公开时间保持null。`minted/max` 按十进制保留，`holders` 单列，独立铸造参与者数量未知。官方接口字段以 [UniSat OpenAPI源文件](https://github.com/unisat-wallet/unisat-dev-docs) 交叉核对；完整策略见 [28 近期部署监控](28-unisat-live-discovery.md)，生产实采另行验收。

## 6. ORDI 历史重建边界

原始 BRC20 实验文档可验证 deploy/mint/transfer 规则以及 ORDI 示例；今天的页面不是2023年某分钟已经公开的证据。历史研究需要独立取得：确切 deploy inscription ID、交易/区块位置与解析版本、完整有效 mint 顺序、当时协议公告的可验证发布时间、当时可用索引器覆盖及真实价格序列。区块时间不等于用户可看到消息时间；现有持有人快照不能倒推出每分钟独立参与人数；后来的上市价格不能补齐铸造期缺失价格。

首版只实现可带 `availableAt` 的通用回放和明确标记的合成 Fixture。未取得上述数据之前不输出“当年能提前发现 ORDI”的历史成绩、不计算虚构收益。历史导入另存证据清单与可用性限制。

## 7. 当前开发环境连接验证记录

2026-11-02 使用 Node 24.15 实际发起受限公共请求：

| Connector                        | 实际结果                                              | 能证明的范围                                                                 |
| -------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Fed RSS                          | 成功取20条并通过标准化；首条发布时间2026-10-29T20:30Z | 当前环境可读取官方RSS与来源时间；不证明持续可用或全部历史完整                |
| GitHub releases（ordinals/ord）  | 成功取30条并通过标准化；首条发布2026-10-19T21:05:41Z  | 指定官方仓库公开release可访问；不代表全生态监控                              |
| Coinbase Exchange                | 请求达到超时/网络失败，有限重试后报错                 | 当前环境连通性未通过，保留真实adapter及mock响应测试；未用Fixture冒充live成功 |
| UniSat / EVM / Solana / LLM / IM | 未提供生产凭据                                        | 只完成接口、配置与相应测试，不能宣称外部生产服务已验收                       |

上述公共请求是连接烟雾测试，不代表取得任何额外数据许可。Fixture管道另在真实PostgreSQL/Redis上验证：5条原始项→5事件→4项目/4信号→通知CANCELLED/SIMULATED，未向真实IM外发。

## 8. 首版链上适配器的真实实现范围

- `EvmFactoryConnector`：仅 Ethereum 主网，必须配置已核验的 V2 兼容 Factory 地址及授权 RPC；校验 eth_chainId=0x1。使用 finalized 区块、指定 PairCreated topic 的 eth_getLogs，每轮最多200块，以每次最多10块（含首尾）的连续分页顺序读取，兼容本次反馈的 RPC 免费套餐10块跨度限制；这只是本系统保守请求上限，不保证所有供应商套餐均可用。请求沿用本地每秒最多2次、超时与退避；逐页校验日志范围，全部页成功才返回下一cursor，失败重试原范围，空页也不能跳过后续页。首次只回看20块并将范围记入cursor。持久 checkpoint 含高度和哈希；哈希不匹配停止，避免把已撤回记录当成有效发现。PairCreated只能证明池被创建，不证明流动性已加入，更不证明代币安全。不是全 ERC20 部署索引、不是所有 DEX 的新池索引。
- `SolanaMintConnector`：仅已配置 program 相关 finalized 交易，解析其中 SPL Token / Token-2022 的 initializeMint/initializeMint2。getTransaction 显式传入数值 maxSupportedTransactionVersion=1，支持 legacy/v0/v1 的 jsonParsed 外层及内部指令；v1 额外的 message.transactionConfig 不参与新 Mint 判断，不读取或推断计算资源/优先费。RPC -32015 单独提示交易版本不支持，归类 PERMANENT，不回显可能含凭据的供应商原始错误、不自动协商未知版本；若响应出现高于v1的版本，同样停止且不推进cursor。初次配置只取最新100条签名作为有界启动窗口；已有checkpoint时按before每轮扫描100条，必须实际找到旧签名后按旧至新每轮处理20笔，恢复进度随PostgreSQL checkpoint持久化。历史缺失、null交易、页面摘要变化或失败均不越过缺口；补偿未完保持degraded。页锚点最多1000页，高流量Program的持续追平受吞吐预算限制，详见[29历史补偿](29-solana-history-recovery.md)。没有抓取全链、没有解析所有新池/launchpad指令。slot时间仅作为eventOccurredAt，sourcePublishedAt保留null，避免伪造可观察时点。
- 两个来源只有配置完整才启用，缺少凭据和范围时 unconfigured。测试使用合成RPC响应覆盖finality、错误链、重组、历史缺口和标准化，不构成实际授权RPC生产验收。
- 官方契约补充：[Solana签名分页](https://solana.com/docs/rpc/http/getsignaturesforaddress)、[Solana交易查询](https://solana.com/docs/rpc/http/gettransaction)、[Solana v1兼容及-32015错误](https://solana.com/docs/core/transactions/versioned-transactions#preparing-for-v1)、[Solana jsonParsed交易结构](https://solana.com/docs/rpc/json-structures)、[Uniswap V2架构及Factory](https://developers.uniswap.org/docs/protocols/v2/concepts/architecture)。

## 9. Treasury 日度收益率正式适配

2026-11-02 实际验证官方 XML：`GET https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=202610` 返回 HTTP 200、`text/xml; charset=UTF-8`。实际字段为 `NEW_DATE`、`BC_2YEAR`、`BC_10YEAR`、`BC_30YEAR`；使用命名空间兼容解析，值按百分比保存，不是价格或同比增幅。

`TreasuryDailyConnector` 每小时轮询当月与前月，初次成功取63条期限观测（2026-10-01至2026-10-30，2Y/10Y/30Y三个期限）。首版此范围提供有限日度历史；没有遍历1990以来全部历史。每个原始项保留完整XML和entry；唯一ID包含资产、日期和值，以便修订值保留新证据。

`sourcePublishedAt=null`、`eventOccurredAt=null`。`NEW_DATE`只有数据日期，保存到`sourceDate`并标记`frequency=daily`、`publicationTimeKnown=false`；不把午夜或feed.updated当精确对外发布时间。`market_observations.observed_at`是系统采样/观察时间，`delay_seconds=null`，前端显示“日度参考收益率 · 发布时间未知”。缺失期限为unknown，不补零；日度历史入库不制造实时价格异动告警。

2026-11-02 设计基线时，黄金实时、WTI/Brent授权实时、BLS CPI/失业/非农观测、EIA库存API尚未接入；目录中调研和Provider边界不代表来源已运行。2026-11-04 补全第三方黄金报价与 EIA 日度 WTI，见下一节；其余未接入项仍显示不可用，不从Fixture获得实时声明。

## 2026-11-04 黄金与原油监控补全设计

- 黄金采用 Gold API 的正式 `GET https://api.gold-api.com/price/XAU` 公开接口。官方 [接口文档](https://gold-api.com/docs)、[FAQ](https://gold-api.com/faqs) 与 [条款](https://gold-api.com/terms) 已核验：最新报价无需 key，允许商业应用；价格每 30 秒更新，项目按 60 秒采样。它是第三方报价服务，并非交易所官方成交源。报价单位为 USD/金衡盎司，`updatedAt` 表示供应商最后取得数据的 UTC 时间，必须原样保留；无承诺 SLA。
- WTI 采用 EIA 正式 [bulk download facility](https://www.eia.gov/opendata/v1/bulkfiles.php) 的 `https://www.eia.gov/opendata/bulk/PET.zip`，流式读取 `PET.txt` 的 `PET.RWTC.D` 序列，找到目标序列即终止下载。不新增 API Key，按小时、ETag/Last-Modified 条件请求。该下载来自 EIA 公布的官方批量文件，包含日期和值，不是实时交易所报价。
- WTI 单位为 USD/桶；`sourceDate` 是数据所属日期，`sourcePublishedAt=null`、`eventOccurredAt=null`，不能把 bulk 的 Last-Modified 或系统采样时刻冒充价格发布时间。保留原始 series 元数据（含来源修订时间），最近 90 个可用日期用作日度历史；缺失、假期与非数值不补零。原始条目标识含资产/日期/值，价格修订保留新证据。
- Gold API 60 秒、EIA 3600 秒轮询；均使用已有超时、重试和限流包装。EIA 下载流增加总读取超时、压缩字节/解压字节/单行长度上限；缺目标序列、无有效观测、坏 zip 或超限均失败并保留健康错误，不伪报成功。
- 控制台与 API 均限制黄金轮询不少于 60 秒、EIA 不少于 3600 秒，避免通用轮询设置绕过采集频率约束。
- [EIA reuse 规则](https://www.eia.gov/about/copyrights_reuse.php) 允许使用其数据并要求来源日期确认；WTI 原始价格由其所列市场报告源整理，界面显示 EIA 与具体日期，保留官方说明链接。项目仍为内部研究用途；未将第三方来源统一标成交易所官方。
- Dashboard 增加黄金/WTI 的轻量入口，行情页继续展示来源、数据时间、频率与单位。Live 与 Fixture 的同资产查询严格隔离，不用 Fixture 填补缺失值。
