# 09 · 机会检测、风险与历史回放

设计版本：1.0 · 2026-11-02。

## 1. 项目身份与状态

项目身份优先使用 `chain:protocol:canonicalAssetId`，未知合约不凭名称自动合并。生命周期主阶段：DISCOVERED → UNVERIFIED → VERIFIED → EARLY_STAGE → ACTIVE → COMPLETED → TRADING；实际允许 VERIFIED→TRADING、ACTIVE→TRADING、任意阶段→INACTIVE，完成后新活动可重新 ACTIVE，但需证据和历史。DISCOVERED 与 UNVERIFIED 可在首次规范化时直接落入 UNVERIFIED。VERIFIED 要求官方信息或链上标识证据，EARLY_STAGE/ACTIVE 要求参与窗口证据，不能仅因为评分高。

`verificationStatus`、`riskFlagged`、`watching` 是独立属性；UI 可显示 WATCHING/RISK_FLAGGED 徽章，不能使风险属性覆盖生命周期，也不能用风险解除证明项目 VERIFIED。每次状态变化保存 from/to/reason/evidenceIds/observedAt。

## 2. 独立信号

| 信号                      | 最低证据                                          |
| ------------------------- | ------------------------------------------------- |
| NEW_PROTOCOL              | 官方规范/发布或已可观察协议工件，不用转发热度代替 |
| NEW_TOKEN_DEPLOYED        | 链/部署交易/代币标识与区块时间                    |
| MINT_STARTED              | 部署规则与开始状态/首个有效铸造记录               |
| MINT_PROGRESS_ACCELERATED | 同来源三个可知快照、两个观测间隔及一致供给分母    |
| UNIQUE_PARTICIPANTS_SPIKE | 窗口与去重钱包数，基线为零需绝对量保护            |
| LIQUIDITY_ADDED           | 已知池地址/交易/流动性金额与来源时间              |
| SOCIAL_MOMENTUM           | 授权社群采样，独立指标，不能单独触发机会 P1       |
| OFFICIAL_ANNOUNCEMENT     | 验证官方域名/账号/仓库组织                        |
| EXCHANGE_LISTING          | 交易所官方公告，仅表示进入市场阶段                |

相同项目可有多个信号，以 projectId/type/evidence fingerprint 唯一。不存在的参与链接、未证实结束时间和费用一律 null/未知。

## 3. 机会评分（0–100，独立于风险）

版本 `opportunity-v1`，建议默认权重：sourceTrust 25、stage 20、freshness 15、participantGrowth 15、conditionTransparency 10、independentConfirmation 10、communityGrowth 5。各维度 0..1，总和加权。缺失不当作满分，记录 coverage 与 unknowns；置信度与 score 独立，不把空字段编造为事实。freshness 使用 firstSeenAt−sourcePublishedAt，不使用未来价格。stage 列表可配置，不能认为越晚越高。返回 breakdown 数值、权重、输入证据和版本。

## 4. 风险评分（0–100）

版本 `risk-v1`，维度：unverifiedOfficial 20、permissions 15、liquidity 15、concentration 10、suspiciousActivity 10、contractSafety 10、phishing 10、cost 5、mutableRules 5。缺失数据有显式未知风险底分/覆盖率，不能将未做审计显示安全。已确认钓鱼、任意铸造/冻结权限或撤池可设 critical flag，通知必须突出；高机会不能抵消 risk 或 critical。风险过滤可降级通知，也可触发安全事件。

权重配置存版本快照，更新仅影响新计算；重算历史须显式选择并标为重新评估。优先级、严重程度、置信度、机会、风险是五个不同字段。

历史撤池等严重风险在生成信号的同一事务内同步到项目摘要，保留至少85分、标记、评分明细和原始证据。后续普通或缺失信息的快照不能解除已确认的严重风险；当前没有人工风险解除工作流，须按保守状态继续核验。真实独立参与者增长同步到摘要并保留测量时间与证据，持有人数不能覆盖它；晚到或未来快照不回写当前摘要。首次未来观测仅保留原始证据，不建立当前项目或事件摘要，后续可知快照可正常建立项目；旧摘要缺观测时间时，从已有可知指标恢复时间基线，无指标则采用已存摘要时间作保守基线。

## 5. 规则

2026-11-05 机会降噪：普通新池、部署、mint 与链上快照只记录观察，旧 `includeRoutineEvents=true` 也不放行。其他链上项目通知须已核验来源、置信度至少80%、机会分至少65、独立风险分至多60，处于 EARLY_STAGE/ACTIVE 且参与条件已核验并有明确说明；用户规则可以继续收紧。`includeRoutineEvents` 仅保留行情快照选择。已确认严重风险通过独立准入，仍须匹配风险规则其他条件。规则测试、创建通知和发送前复查共用判定；详见 [38 机会通知降噪](38-opportunity-notifications.md)。AI 候选准入与通知规则分别执行，见 [34 候选优先分析](34-candidate-first-analysis.md)。

Zod 允许有限条件字段：eventType、sourceIds、assets、categories、chain、stage、minConfidence、minOpportunityScore、maxRiskScore、participantGrowthPct、mintProgress、priceChangePct、yieldChangeBps、windowSeconds、maxAgeSeconds。规则字段按全部满足，单一列表内部任一值匹配；多条规则可分别设置不同事件组合。禁止任意递归深度/无限数组/eval。冷却按 ownerId/ruleId/projectOrEvent/channel 生效。P0 只由明确信号及验证证据产生；规则测试只返回匹配及原因，不发送。

### 当前历史差分实现

`packages/signals/src/history.ts` 采用可复现的 `history-v1` 默认阈值。只比较同来源、项目、数据模式下的可知观测；新采样必须晚于已有样本，间隔为60秒至6小时。三点铸造速度按百分比点/小时计算，至少增加1个百分点、速度至少翻倍且增加1个百分点/小时；任一样本提供max时，全部max必须存在且规范化后相同。持有人数与独立参与人数严格分离。

参与者增长需基线至少10人、绝对增加20人且增幅50%；流动性增加需5000美元且20%，撤出需5000美元且30%；成交量要求相同统计窗口、基线1000美元、增加5000美元且200%。社群计数仅在可靠来源显式提供相同时间窗口时比较，不默认采集社交网站或将热度单独升级为P1。

Worker持久保存project_metrics与原始证据ID，按实际观测时间排序，晚到历史记录不能覆盖较新项目状态。独立signal保存当时版本/分数/原因/证据，并进入相同规则/outbox路径。已验证且有明确参与条件与结束时间的窗口在每次reconcile及 `--once` 随时钟扫描，进入结束前一小时或到期后分别生成幂等信号；不自动把单次活动结束等同整个项目完成。没有可靠参与者、成交量、社交或窗口证据的live来源保持未知，通用算法通过Fixture验证不等于这些live数据已接入。

## 6. 回放防泄漏

回放时钟 T 只能使用 `availableAt = max(sourcePublishedAt, possibleObservedAt)` 不晚于 T 的证据；历史缺失 possibleObservedAt 时以公开时间+声明的采集假设，并标记估计。firstSeenAt 为现网实际时间，不能把今天导入历史记录声称当年已发现。所有指标、验证、官方确认、来源关联、AI 结果必须按 availableAt 截断，不能用今天的声誉、上币结果、收益或最终铸造量评分。

回放输出检测时间、可用证据、评分版本、触发原因、未覆盖来源、已知漏报/误报与数据缺失；无标注 ground truth 时漏报率/误报率为未知。通用 Fixture 验证时间过滤、未来指标不参与、确定性与重复性。ORDI 历史重建需要可验证的 inscription/部署与铸造记录、公开时间和当时可用渠道，未取得完整数据只能列研究缺口，不能生成收益曲线或声称抓住 ORDI。
