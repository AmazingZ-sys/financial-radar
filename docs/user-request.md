# Financial Radar —— AI 金融热点雷达与早期机会发现系统

## 一、你的角色和核心任务

你是一名资深全栈架构师、金融数据工程师、区块链链上数据工程师、AI 应用架构师、DevOps 工程师和高级软件测试工程师。

现在需要你从零开始，独立设计并实现一个生产可部署的金融热点监控与早期机会预警平台，项目名称为：

**Financial Radar（金融雷达）**

这是一个完整的软件工程项目，不是技术演示、概念验证页面或简单的信息聚合工具。

你需要承担以下全部工作：

1. 分析产品需求和技术可行性。
2. 研究金融数据和区块链数据的获取方式。
3. 编写完整的产品需求文档（PRD）。
4. 编写系统架构设计文档。
5. 编写数据库设计和 API 文档。
6. 编写数据采集、事件分析和预警算法设计。
7. 制定分阶段实施计划、依赖关系和验收标准。
8. 初始化 Monorepo 工程。
9. 实现前端、后端、数据库、Worker 和通知服务。
10. 完成自动化测试、安全检查和异常恢复。
11. 实现 Docker 部署与 GitHub Actions 自动发布。
12. 编写开发、部署、配置、运维及故障排查文档。
13. 按阶段执行、验证、记录结果，直至项目完成。

**重要要求：必须先完成文档和实施计划，再逐阶段进行代码实现。**

不允许直接跳过设计阶段生成大量代码。

也不允许只输出一份计划就认为任务完成。

在文档和计划完成后，应按照计划逐阶段实施，每完成一个阶段都进行测试、验收和记录，然后继续下一阶段。

如果遇到缺少第三方 API Key、生产服务器权限、付费数据授权等外部依赖，应实现可工作的 Mock/Fixture、配置接口和测试流程，记录阻塞项，不要因此停止全部开发。

---

# 二、项目背景和产品目标

## 2.1 项目背景

用户希望建立一套全天候金融热点监控系统，及时获取可能影响投资市场的重要消息，同时尽早发现值得研究的新兴投资机会。

重点涉及：

- 黄金
- 美国国债
- 原油
- 美联储政策
- 全球宏观经济
- 比特币
- 以太坊
- Solana 等公链生态
- BRC-20
- Ordinals
- Runes
- Meme 资产
- 新协议和新项目
- 新币部署、铸造、空投和交易所上市
- 金融市场异常波动
- 其他新兴金融热点

项目的重要动机之一，是用户曾经错过 ORDI 这类早期 BRC-20 资产的参与窗口。

系统需要尽可能在某种新协议、新资产或新的市场叙事刚刚出现时就捕捉到信号，而不是等到主流媒体报道或资产大幅上涨以后才提示。

需要特别区分：

**普通新闻热点发现**

发现已经公开的重要金融事件，并尽快通知。

**早期机会发现**

通过链上数据、协议动态、开发者活动和社区信号发现刚刚出现的新事物，并持续跟踪其发展阶段。

第二项是本项目的核心差异化能力。

## 2.2 产品目标

建立一个具有以下能力的系统：

1. 7×24 小时自动监控指定金融和区块链数据源。
2. 识别重要金融事件、新项目与市场异常。
3. 将多来源信息聚合为统一事件。
4. 自动去重、过滤噪声和识别异常。
5. 利用规则引擎和 AI 分析事件价值。
6. 自动评估早期参与机会和风险。
7. 根据严重程度和用户配置分级推送。
8. 支持 Telegram、飞书、Bark 等通知渠道。
9. 提供可视化 Web 控制台。
10. 允许用户管理观察列表、规则和推送偏好。
11. 保存历史消息、分析记录和通知结果。
12. 支持历史事件回放与规则效果评估。
13. 支持未来扩展为 App、微信小程序和多用户平台。

## 2.3 核心原则

- 早发现优先于事后分析。
- 数据真实性优先于信息数量。
- 多来源验证优先于单一来源推测。
- 事件可追溯优先于黑盒 AI 判断。
- 及时通知优先于复杂但缓慢的 AI 分析。
- 风险必须独立于机会评分。
- 核心预警链路不能依赖单个 AI 模型。
- 服务故障必须能够自动恢复。
- 允许信息缺失，但不允许伪造实时数据。
- 不以历史收益作为未来收益保证。
- 不提供自动交易或未经用户确认的链上签名行为。

---

# 三、正式技术架构要求

以下技术方案已确定，原则上不得擅自替换。

如存在明确的技术冲突，应先记录问题、分析原因并提出兼容方案。

## 3.1 前端

技术栈：

- Vue 3
- TypeScript
- Vite
- Pinia
- Vue Router
- TanStack Query（Vue Query）
- Tailwind CSS
- Element Plus
- ECharts
- Zod
- Vitest
- Playwright

要求：

1. 使用 Composition API 和 `<script setup>`。
2. 全项目启用 TypeScript Strict Mode。
3. 使用统一 API Client。
4. 接口类型尽量通过 OpenAPI 自动生成。
5. 前端以中文为默认语言。
6. 预留 i18n 扩展接口。
7. 支持桌面端和移动端响应式布局。
8. 支持深色与浅色主题。
9. 具备完整的 Loading、Empty、Error 和 Retry 状态。
10. 不允许前端直接保存第三方服务私密 API Key。
11. 不允许使用静态假数据伪装真实监控结果。
12. 图表数据必须有时间戳、来源和加载状态。

前端部署平台：

**Netlify**

## 3.2 后端

技术栈：

- Hono
- Node.js LTS
- TypeScript
- Zod
- OpenAPI
- Drizzle ORM
- PostgreSQL
- Redis
- BullMQ

要求：

1. 使用模块化单体架构。
2. API 和后台 Worker 可以独立运行、独立扩缩容。
3. 保持 Controller、Service、Repository 等职责清晰。
4. 使用 Zod 进行输入校验。
5. 统一错误码、错误响应和异常处理。
6. 提供 OpenAPI 文档。
7. 实现结构化日志、请求 ID 和链路关联。
8. 实现请求限流和基础安全防护。
9. 支持优雅关闭。
10. 保证队列任务幂等。
11. 具备数据源健康检查。
12. 对外部 API 实现超时、重试、退避和熔断策略。
13. 不把耗时的 AI 分析放到同步请求关键路径中。

后端部署方式：

**Docker Compose**

## 3.3 数据库

使用 PostgreSQL 作为核心持久化数据库。

使用 Drizzle ORM 管理 Schema 与 Migration。

使用 Redis 管理：

- 异步任务
- 定时任务协调
- 缓存
- 短期去重
- 通知队列
- 限流
- 分布式任务锁

业务事实数据、历史事件和通知记录必须持久化到 PostgreSQL。

不能把 Redis 当成唯一数据存储。

## 3.4 AI 模块

设计统一 AI Provider 抽象层。

要求：

- 可接入不同 LLM 提供商。
- 支持模型配置。
- 支持结构化 JSON 输出。
- 支持 Zod Schema 验证。
- 支持超时和失败重试。
- 支持 Token 使用统计。
- 支持成本限制。
- 支持 Prompt 版本管理。
- 支持分析结果缓存。
- 支持降级。
- 支持人工复核状态。

AI 不得虚构：

- 来源链接
- 交易数据
- 项目发布日期
- 链上合约地址
- 参与条件
- 项目团队身份
- 尚未验证的公告

AI 的所有实质性判断必须尽量关联具体证据。

## 3.5 自动化部署和版本发布

正式确定：

- Docker 镜像仓库：**GHCR**
- Nginx 部署模式：**nginx-host**
- 版本发布策略：**semantic**
- CI/CD：**GitHub Actions**
- 前端部署：**Netlify**
- 后端部署：**Docker**
- 生产环境反向代理：宿主机 Nginx

采用 Conventional Commits 和 semantic-release。

需要支持：

1. Push 后自动执行代码检查和测试。
2. 通过测试后自动构建。
3. 根据提交类型自动计算语义化版本。
4. 自动创建 Git Tag。
5. 自动生成 GitHub Release。
6. 自动生成 Changelog。
7. 自动构建 API、Worker 镜像。
8. 推送镜像到 GHCR。
9. 将版本信息和 Git Commit SHA 写入镜像。
10. 使用 GitHub Actions 部署 Netlify 前端。
11. 支持生产服务器脚本一键更新。
12. 支持部署失败回滚。
13. 不使用不受控的 latest 标签作为唯一生产部署依据。

注意 GitHub Actions 的 GITHUB_TOKEN 产生的事件可能不会触发其他普通工作流，需要明确设计 Release 与镜像构建的可靠依赖关系，避免发布流程中断。

---

# 四、Monorepo 工程架构

建议使用 pnpm workspace。

可以采用 Turborepo 管理任务依赖、构建和缓存。

预期结构：

financial-radar/

apps/

- web：Vue 3 管理后台
- api：Hono HTTP API
- worker：数据采集、分析和通知任务

packages/

- shared：共享类型、常量、Schema
- database：Drizzle Schema、Migration、Repository
- connectors：数据源适配器
- signals：事件检测与信号计算
- ai：AI Provider 与分析服务
- notifications：通知渠道适配器
- config：统一配置读取和校验
- observability：日志、监控和追踪工具

infra/

- docker：Dockerfile 和容器配置
- nginx：Nginx 配置示例
- scripts：部署、回滚、备份与检查脚本

docs/

- 需求、架构、接口、数据模型、部署、测试、运维等文档

.github/workflows/

- CI、Release、构建、镜像发布和前端部署工作流

同时包含：

- docker-compose.yml
- docker-compose.dev.yml
- pnpm-workspace.yaml
- turbo.json
- .env.example
- README.md
- CHANGELOG.md
- AGENTS.md

可以在详细设计阶段适当调整目录，但必须说明理由。

要求各模块之间有清晰边界，不允许所有业务代码堆积在 API 入口文件。

---

# 五、金融数据监控设计

## 5.1 区块链监控

这是项目最高优先级的业务模块。

需要研究并逐步支持：

### Bitcoin 生态

- Ordinals
- BRC-20
- Runes
- 新协议发布
- 代币部署
- 铸造开始
- 铸造进度
- 独立参与地址数量
- 地址参与变化
- 新资产交易市场出现
- 官方协议动态
- 项目开发动态

特别关注：

如何在新协议刚出现、或 BRC-20 资产刚开始部署和铸造时发现候选项目。

不能仅依赖交易所上币公告。

### Ethereum / EVM 生态

- 新 Token 合约部署
- 新交易对创建
- 初始流动性添加
- 流动性变化
- 独立持币地址变化
- 交易活跃度
- 异常大额交易
- 合约风险
- 官方项目动态

### Solana 生态

- 新 Mint
- 新交易池
- 流动性增加
- 交易量异常
- 参与钱包数量变化
- 新项目和新叙事

以上监控必须优先考虑合法授权、稳定性和数据完整性。

对于全链实时监控这种成本较高的能力，先分析数据提供商、WebSocket、索引器以及自建节点方案的差异，再选择合适的初期实现。

不要求第一阶段完成所有公链的全量覆盖，但必须设计可扩展的链上适配器架构。

## 5.2 新项目生命周期

每个候选项目应具有以下状态：

- DISCOVERED：首次发现
- UNVERIFIED：待验证
- VERIFIED：基本信息已验证
- EARLY_STAGE：早期参与阶段
- ACTIVE：活动或铸造进行中
- COMPLETED：相关活动结束
- TRADING：进入交易阶段
- WATCHING：持续观察
- RISK_FLAGGED：存在重要风险
- INACTIVE：停止跟踪或失活

这些状态不是严格的单一路径。

需要设计状态转移规则，明确哪些状态互斥、哪些属于独立的风险或观察属性。

系统应记录：

- 首次发现时间
- 来源发布时间
- 当前生命周期阶段
- 项目官方来源
- 合约或资产标识
- 当前可参与条件
- 活动开始时间
- 活动结束时间
- 发现时的链上指标
- 历史指标变化
- AI 分析记录
- 预警历史
- 风险标记

## 5.3 黄金监控

关注：

- 国际现货黄金
- 黄金期货
- 价格异常波动
- 美元指数
- 美国实际利率
- 美联储政策
- 重大地缘政治事件
- 重要黄金市场新闻

不同价格来源可能存在交易时段、延迟及授权差异。

需要设计行情 Provider 抽象接口。

如果无法获得授权实时数据，应明确标记数据延迟，禁止用历史行情冒充实时行情。

## 5.4 美国国债监控

关注：

- 美国 2 年期国债收益率
- 美国 10 年期国债收益率
- 美国 30 年期国债收益率
- 收益率曲线变化
- 国债拍卖结果
- 国债供给变化
- 美联储利率政策
- 期限利差
- 异常收益率波动

候选数据源：

- FRED
- U.S. Treasury
- TreasuryDirect
- 其他获得授权的数据商

需要区分日度经济数据和实时债券行情。

## 5.5 原油监控

关注：

- WTI
- Brent
- EIA 原油库存
- OPEC+ 政策
- 原油供应变化
- 地缘政治风险
- 重大能源行业事件
- 价格和成交量异常

候选数据源：

- EIA
- OPEC 官方信息
- 授权行情服务商
- 合规新闻和公告来源

## 5.6 全球宏观经济

关注：

- CPI
- PPI
- 非农就业
- 失业率
- FOMC
- 利率决议
- GDP
- PCE
- 美元指数
- 美联储官员讲话
- 其他对金融市场有较大影响的数据

需要建设经济日历模块，支持：

- 即将发布的事件
- 事件所属国家或地区
- 预定发布时间
- 历史值
- 预期值
- 实际值
- 重要程度
- 事件是否已经确认发布

如果某项字段没有可靠来源，应显示未知，不得自行填充。

---

# 六、数据源调研和适配器体系

在开始实现数据采集之前，必须先创建：

`docs/data-sources.md`

针对每个候选数据源研究：

1. 官方文档地址
2. 数据类型
3. 可用 API / RSS / WebSocket / Webhook
4. 授权和使用限制
5. 免费或付费模式
6. 请求频率限制
7. 数据更新频率
8. 预期延迟
9. 历史数据获取方式
10. 数据可靠性
11. 是否允许商业使用和再分发
12. 服务故障情况下的替代方案
13. 是否需要注册 API Key
14. 是否适合当前 MVP

优先研究：

- Binance 官方公告与市场接口
- Coinbase 官方公告与市场接口
- DEX Screener
- Bitcoin Ordinals/BRC-20 数据服务
- 适用的 EVM 链上索引器
- 适用的 Solana 链上索引器
- Federal Reserve
- FRED
- BLS
- U.S. Treasury
- EIA
- 合法授权的 RSS 和新闻渠道
- 官方项目文档及 GitHub Release

不要假设历史上存在的接口今天仍然可用。

必须根据开发时能获取的官方文档验证实际支持情况。

禁止未经授权绕过登录、验证码、反爬机制或 API 配额。

### 数据源接口设计

每个 Connector 应支持统一生命周期：

- initialize
- fetch / subscribe
- normalize
- healthCheck
- shutdown

同时提供：

- SourceMetadata
- CapabilityDescriptor
- RateLimitPolicy
- Cursor / Checkpoint
- ErrorClassification
- RetryPolicy

需要区分：

- Pull Connector
- Streaming Connector
- Webhook Connector

增加统一的 Connector Registry。

支持配置启用、禁用、轮询周期、密钥、速率限制和健康检查策略。

所有采集任务必须具备超时和失败恢复能力。

---

# 七、事件处理与机会发现引擎

## 7.1 标准事件处理流程

必须实现以下流程：

**数据采集 → 原始数据保存 → 数据标准化 → 去重聚合 → 规则检测 → 来源验证 → 机会评分与风险检测 → 通知决策 → 消息发送 → 结果记录**

重要要求：

原始数据必须尽量保留，以便未来重新分析。

不得只存储 AI 总结结果。

## 7.2 事件标准字段

事件模型至少包含：

- eventId
- eventType
- sourceId
- externalId
- title
- description
- originalUrl
- sourcePublishedAt
- firstSeenAt
- collectedAt
- eventOccurredAt
- assets
- categories
- rawDataReference
- fingerprint
- confidence
- severity
- verificationStatus
- analysisStatus
- createdAt
- updatedAt

需要区分事件原始发生时间、数据来源发布时间与系统第一次观察到的时间。

这些字段对历史回测至关重要。

## 7.3 事件去重

同一事件可能通过多个来源重复出现。

需要支持：

- URL 规范化
- 外部 ID 去重
- 来源事件指纹
- 标题与内容相似度
- 时间窗口聚合
- 多来源合并
- 防止相同事件反复通知

第一版采用确定性规则和可维护的文本相似度机制。

向量检索属于可选增强，不是 MVP 的必要依赖。

注意不要把两个不同项目、不同合约地址或不同区块事件错误合并。

## 7.4 早期机会识别

需要重点实现：

- 新协议出现
- 新 Token 部署
- 新资产可参与
- 铸造进度变化
- 独立参与钱包增长
- 社区热度变化
- 项目从测试阶段进入正式阶段
- 即将结束的早期参与窗口
- 新交易对出现
- 项目可信度发生变化

建立 Opportunity Signal 模型。

一个项目可能存在多个独立信号。

例如：

- NEW_PROTOCOL
- NEW_TOKEN_DEPLOYED
- MINT_STARTED
- MINT_PROGRESS_ACCELERATED
- UNIQUE_PARTICIPANTS_SPIKE
- LIQUIDITY_ADDED
- SOCIAL_MOMENTUM
- OFFICIAL_ANNOUNCEMENT
- EXCHANGE_LISTING

不能只根据社交媒体热度判断机会。

要能区分：

- 链上首次出现
- 官方首次公开
- 活动正式开放
- 主流市场开始讨论
- 进入交易阶段

## 7.5 评分体系

设计两套独立评分：

**OpportunityScore：机会发现评分**

参考维度：

- 来源可信度
- 项目所处阶段
- 发现时效性
- 真实参与增长
- 参与条件透明度
- 独立信息源确认情况
- 社区关注增长

**RiskScore：风险评分**

参考维度：

- 官方来源是否验证
- 合约和代币权限
- 流动性风险
- 持币集中度
- 可疑交易模式
- 智能合约安全性
- 假冒链接风险
- 交易与铸造成本
- 项目规则是否可变
- 未知风险

所有评分权重必须可配置、可版本化。

评分计算必须可解释。

不得简单地以“AI 认为值得投资”作为唯一依据。

高机会评分不能覆盖严重的风险警告。

对于证据不足的项目，可以保留观察信号，但必须明确标记为未验证。

## 7.6 历史回放和回测

实现历史信号回放框架。

重点研究 ORDI 早期部署、铸造及市场扩散的时间线是否能够使用可靠的历史数据重建。

回放需要严格避免未来信息泄漏。

只能使用在回放时间点已经公开且理论上可获取的信息。

需要区分：

- 事件真实发生时间
- 来源对外发布时间
- 系统可能观察到的时间
- 实际历史价格数据

输出：

- 发现时间
- 检测到的信号
- 当时可用证据
- 当时评分
- 通知触发原因
- 漏报情况
- 误报情况
- 数据不可得的情况

如无法取得完整历史数据，不得伪造回测结果。

可以先完成通用回放框架，并用明确标记的测试 Fixture 验证。

---

# 八、AI 分析系统

AI 负责辅助分析，不负责替代原始数据采集。

## 8.1 AI 分析能力

实现：

1. 新闻分类
2. 新闻摘要
3. 重要事件提取
4. 项目概要分析
5. 金融资产关联分析
6. 热点趋势归纳
7. 风险解释
8. 机会发现原因解释
9. 不同来源观点对比
10. 每日金融摘要

AI 输出统一结构化结果，至少包括：

- summary
- classification
- relatedAssets
- keyFacts
- evidenceIds
- possibleImpact
- uncertainty
- riskWarnings
- suggestedPriority
- modelVersion
- promptVersion

需要明确区分：

- 已验证事实
- 模型推断
- 尚无证据支持的猜测

## 8.2 AI 降级机制

如果 AI 服务不可用：

- 数据采集继续运行。
- 规则检测继续运行。
- P0/P1 确定性事件仍可推送。
- AI 分析任务进入重试队列。
- 管理后台展示 AI 状态。
- 失败不能导致消息丢失。

关键预警可以先发送简要通知，之后补充 AI 解读。

## 8.3 AI 成本控制

支持：

- 单次分析预算
- 每日调用额度
- Token 统计
- 结果缓存
- 相似事件合并分析
- 低优先级事件跳过深度分析
- 模型分级调用
- 超预算自动降级

必须在管理后台展示相关统计。

---

# 九、实时预警和通知系统

## 9.1 预警级别

定义四级预警：

**P0：紧急事件**

例如重大官方突发事件、重要市场基础设施故障或经验证的重大安全事故。

**P1：高优先级机会**

例如可信的新协议开放早期参与、新资产重要阶段变化或重要上市公告。

**P2：重要热点**

例如经济数据、价格异动、利率变化、重大行业新闻。

**P3：普通资讯**

例如常规市场动态、研究报告和普通新闻。

需要将：

- 事件严重程度
- 机会评分
- 风险等级
- 证据置信度
- 通知优先级

设计成相互独立的字段，不能混为一个分数。

## 9.2 自定义规则

用户可配置：

- 监控资产
- 监控分类
- 时间窗口
- 价格波动阈值
- 收益率变化阈值
- 铸造进度阈值
- 参与地址增长阈值
- 新项目来源
- 最低置信度
- 最低机会评分
- 风险过滤条件
- 推送渠道
- 推送时间段
- 通知冷却时间

规则必须使用安全、可验证的数据结构。

禁止通过 eval 执行用户配置表达式。

## 9.3 通知渠道

第一阶段必须实现：

- Telegram Bot

后续逐步实现：

- 飞书 Bot
- Bark
- Web Push
- 邮件
- 其他 IM 机器人接口

统一 NotificationProvider。

需要：

- 消息模板
- 模板版本
- 发送队列
- 发送失败重试
- 速率限制
- 通知去重
- 通知状态记录
- 通知测试功能
- 渠道启用与禁用

通知数据库状态至少包括：

- PENDING
- SENDING
- SENT
- FAILED
- RETRYING
- CANCELLED

需要根据具体渠道区分平台接受发送与用户实际收到消息，不得将接口响应成功直接解释为用户已阅读。

## 9.4 通知格式

建议一条重要消息包含：

- 事件标题
- 资产或项目名称
- 事件发生和发现时间
- 事件级别
- 可信度
- 当前阶段
- 关键变化
- AI 简要解释
- 风险提示
- 官方来源
- 详细页面链接

对于早期机会额外显示：

- 项目首次发现时间
- 是否仍在可参与阶段
- 参与条件是否已验证
- 链上参与情况
- 潜在费用
- 是否存在明显风险

禁止在未经验证的情况下提供伪造的参与地址或诱导签名链接。

---

# 十、Web 管理后台

后台应该具有专业金融信息终端风格。

整体要求：

- 简洁
- 清晰
- 数据密度合理
- 响应式
- 深色模式
- 便于快速识别风险和重要事件

## 10.1 仪表盘

展示：

- 当前在线数据源数量
- 数据源健康状态
- 今日采集数据量
- 今日识别事件数量
- 今日发现的新项目数量
- 高优先级预警数量
- 通知成功率
- 最近告警
- 最近早期机会
- Worker 任务状态

不能将模拟数据当作实时数据。

## 10.2 实时热点

支持：

- 事件流
- 分类过滤
- 时间过滤
- 资产过滤
- 优先级过滤
- 关键词搜索
- 事件详情
- 来源追溯
- AI 分析结果

## 10.3 早期机会中心

这是最重要的页面。

展示：

- 新发现项目
- 协议类别
- 所属公链
- 首次发现时间
- 项目当前阶段
- 机会评分
- 风险评分
- 独立参与变化
- 铸造进度
- 来源可信度
- 项目状态变化

提供项目详情页和完整历史时间线。

## 10.4 行情监控

支持：

- BTC
- ETH
- 黄金
- 原油
- 美债收益率
- 其他后续配置资产

显示：

- 最新可用数据
- 数据时间戳
- 价格或收益率变化
- 历史走势
- 关联事件
- 数据延迟提示

## 10.5 预警规则管理

实现：

- 新建规则
- 编辑规则
- 禁用规则
- 删除规则
- 测试规则
- 查看规则触发历史

## 10.6 通知中心

实现：

- 通知渠道配置
- Telegram 测试消息
- 通知偏好
- 冷却时间设置
- 通知历史
- 失败记录
- 重试状态

## 10.7 数据源管理

展示：

- Connector 名称
- 数据类别
- 当前状态
- 最后成功采集时间
- 数据新鲜度
- 请求成功率
- 错误信息
- 下次采集计划
- 可用配额或剩余调用量（如来源提供）

## 10.8 系统管理

包含：

- 用户和权限
- API Key 配置状态
- AI Provider 状态
- 服务版本
- Worker 状态
- 队列状态
- 监控指标
- 系统日志查询
- 系统设置

密钥仅显示是否配置及必要的脱敏信息。

不得通过普通管理接口返回完整密钥。

---

# 十一、数据库设计

必须先编写：

`docs/database-design.md`

再创建真实数据库 Schema 和 Migration。

建议包括但不限于以下实体：

### 用户与配置

- users
- user_sessions
- user_settings
- watchlists
- watchlist_items

### 数据源

- data_sources
- source_checkpoints
- source_health_records
- ingestion_runs
- raw_items

### 事件系统

- events
- event_sources
- event_assets
- event_evidence
- event_analyses
- event_clusters

### 项目监控

- projects
- project_assets
- project_sources
- project_lifecycle_events
- project_metrics
- opportunity_signals
- risk_assessments

### 预警

- alert_rules
- alert_rule_versions
- alert_triggers
- notifications
- notification_channels
- notification_attempts

### AI 和审计

- ai_analysis_runs
- ai_usage_records
- audit_logs
- system_settings

设计要求：

1. 统一主键策略。
2. 明确数据库索引。
3. 明确唯一约束。
4. 避免重复事件。
5. 使用 UTC 存储时间。
6. 前端根据用户时区展示。
7. 重要状态保留变更历史。
8. 对高频指标设计分区或归档策略。
9. 保留数据来源和证据。
10. 明确数据保留周期。
11. 对敏感配置进行保护。
12. 为未来多用户提供合理扩展空间。
13. 使用可重复执行和可验证的 Migration。
14. 禁止在生产部署时未经确认地执行破坏性数据库操作。

第一版可以优先采用单用户管理员模式，但设计上不能严重阻碍未来多用户支持。

---

# 十二、API 设计

必须编写：

`docs/api-design.md`

提供 OpenAPI 文档。

建议至少支持：

### 系统

- GET /health
- GET /ready
- GET /api/v1/system/status

### 事件

- GET /api/v1/events
- GET /api/v1/events/:id
- GET /api/v1/events/:id/sources

### 项目

- GET /api/v1/projects
- GET /api/v1/projects/:id
- GET /api/v1/projects/:id/timeline
- GET /api/v1/projects/:id/signals

### 预警

- GET /api/v1/alerts
- GET /api/v1/alert-rules
- POST /api/v1/alert-rules
- PATCH /api/v1/alert-rules/:id
- DELETE /api/v1/alert-rules/:id

### 数据源

- GET /api/v1/sources
- GET /api/v1/sources/:id
- GET /api/v1/sources/:id/health

### 通知

- GET /api/v1/notifications
- GET /api/v1/notification-channels
- POST /api/v1/notification-channels/test

### 行情

- GET /api/v1/markets/assets
- GET /api/v1/markets/history

### 用户和设置

- 用户认证
- 当前用户信息
- 个人设置
- 观察列表管理

接口命名和具体路径可在设计阶段调整。

要求：

- 统一鉴权。
- 明确权限边界。
- 支持分页。
- 支持查询过滤。
- 支持统一错误响应。
- 敏感接口限流。
- 返回字段经过 Schema 验证。
- 提供自动化接口测试。
- 文档与实际代码保持一致。

---

# 十三、安全和可靠性要求

## 13.1 账户安全

实现：

- 管理员登录
- 安全密码哈希
- 安全 Session 或等效认证机制
- Cookie 安全属性
- CSRF 防护（适用时）
- 登录限流
- 权限校验
- 敏感操作审计

## 13.2 密钥安全

API Key、Telegram Token、数据库密码等通过环境变量或安全密钥管理方案注入。

要求：

- 不提交真实密钥到 Git。
- 提供 .env.example。
- 不在普通日志中输出密钥。
- 不在浏览器暴露密钥。
- 不将生产密钥放入测试 Fixture。
- 提供密钥轮换说明。

## 13.3 金融与链上安全

系统定位为信息监控与辅助分析平台。

第一版不实现：

- 自动买币
- 自动卖币
- 自动交易
- 钱包私钥管理
- 自动签名
- 助记词存储
- 根据 AI 判断直接执行资金操作

对未知资产必须有风险提示。

## 13.4 故障恢复

必须考虑：

- 数据源 API 超时
- 数据源限流
- 网络中断
- Redis 重启
- PostgreSQL 重启
- Worker 异常退出
- AI Provider 不可用
- Telegram 发送失败
- 消息重复
- 服务重启后的任务恢复

对于每个场景提供恢复策略和必要测试。

---

# 十四、实时性和可观测性

系统不是只需要“功能能跑”，还必须能够度量真正的发现速度。

至少追踪：

- sourcePublishedAt
- firstSeenAt
- normalizedAt
- detectedAt
- queuedAt
- deliveredAt

计算：

- 数据发现延迟
- 信号识别延迟
- 通知排队延迟
- 通知发送延迟
- 端到端延迟

展示 P50、P95 等统计结果。

不同数据源分别设定可达到的时效目标。

不得承诺所有宏观数据和链上消息都能在几秒内发现。

需要支持：

- 结构化日志
- 服务健康检查
- Worker 健康检查
- 队列积压监控
- 数据源新鲜度监控
- 失败任务统计
- AI 调用失败率
- 通知发送成功率
- 事件处理吞吐量

第一版优先完成必要监控，不强制引入复杂的完整可观测性平台。

---

# 十五、Docker 与生产部署

## 15.1 Docker Compose

至少包含：

- api
- worker
- postgres
- redis

要求：

- 合理的健康检查
- 数据持久化卷
- 环境变量配置
- 自动重启策略
- 服务依赖关系
- 日志管理
- 最小化容器权限
- 合理资源限制
- 开发与生产配置分离

生产环境数据库和 Redis 不应默认暴露到公网。

## 15.2 宿主机 Nginx

采用 nginx-host 模式。

即：

Nginx 安装在宿主机，不作为 Docker Compose 内的容器运行。

Nginx 将 API 请求反向代理到 Docker API 服务。

需要提供：

- Nginx 配置模板
- HTTPS 部署建议
- Host、Origin 和代理头配置
- WebSocket 支持（如实际需要）
- 合理超时
- 安全响应头
- 日志配置
- 配置检测脚本

一键部署应在 `nginx -t` 通过后执行平滑 reload，必要时按明确配置执行 restart。

不得无条件强制重启 Nginx。

## 15.3 一键部署

必须实现：

`infra/scripts/deploy.sh`

支持：

- 检查服务器环境
- 检查 Docker 和 Compose
- 登录或使用已有 GHCR 凭据
- 获取指定 Release 版本
- 拉取指定版本镜像
- 校验配置
- 数据库备份或安全性检查
- 安全执行 Migration
- 更新 API 与 Worker
- 执行健康检查
- 检查 Nginx 配置
- 平滑重新加载 Nginx
- 输出部署结果

还需要：

`infra/scripts/rollback.sh`

支持回滚到上一个已验证的应用版本。

注意数据库迁移可能无法安全逆转，需要设计向前兼容策略，不能简单地把应用镜像回滚视为数据库也已回滚。

另提供：

- backup.sh
- check-health.sh
- deploy.example.env

所有部署操作应保证尽量幂等。

---

# 十六、GitHub Actions 与发布策略

采用语义化版本策略：

- feat：增加 Minor 版本
- fix：增加 Patch 版本
- BREAKING CHANGE：增加 Major 版本

使用 Conventional Commits。

需要实现以下流程：

## CI

Pull Request 和主分支 Push 运行：

1. 安装依赖
2. TypeScript 类型检查
3. ESLint
4. 格式检查
5. 单元测试
6. 集成测试
7. 前端构建
8. API 构建
9. Worker 构建
10. 必要安全检查

## Release

主分支通过验证后：

1. semantic-release 计算版本。
2. 创建 Git Tag。
3. 发布 GitHub Release。
4. 生成 Changelog。
5. 构建 Docker 镜像。
6. 推送 GHCR。
7. 发布 Netlify 前端。
8. 输出发布版本和构建信息。

生产镜像建议使用不可变的版本与摘要进行部署。

需要处理 GitHub Actions Token 事件触发限制，确保工作流能够真实运行。

## 服务器更新

用户在服务器执行部署脚本即可将应用更新至指定版本。

应支持显式指定版本，并可选择获取最新稳定 Release。

部署过程中不允许因为普通代码更新而删除 PostgreSQL 数据卷。

---

# 十七、文档先行制度

这是整个项目最重要的执行规则。

**在正式编写业务代码之前，必须创建并填写以下文档。**

建议文档清单：

- docs/00-project-overview.md
- docs/01-requirements.md
- docs/02-feasibility-study.md
- docs/03-data-sources.md
- docs/04-system-architecture.md
- docs/05-module-design.md
- docs/06-database-design.md
- docs/07-api-design.md
- docs/08-event-pipeline.md
- docs/09-opportunity-detection.md
- docs/10-ai-analysis.md
- docs/11-notification-design.md
- docs/12-frontend-design.md
- docs/13-security-design.md
- docs/14-deployment-design.md
- docs/15-testing-strategy.md
- docs/16-operation-guide.md
- docs/17-implementation-plan.md
- docs/18-risk