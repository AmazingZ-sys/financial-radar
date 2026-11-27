# 研究复核、每日摘要与配置补充

2026-11-02，设计与实现补充。API注册在research-routes.ts，沿用统一鉴权、输入/输出Schema、CSRF/Origin和审计。

- POST /api/v1/events/{id}/review：APPROVED/REJECTED + 可选note，仅在AI分析完成后允许；保存reviewerId/reviewedAt，不改变verificationStatus、分数、原始指标或链上事实。
- GET /api/v1/projects/{id}/metrics：最多500条原始指标观测，来源和时间均保留，不进行虚构插值。
- GET /api/v1/digests/daily?day=YYYY-MM-DD：按UTC日首次观察时间汇总已保存事件（最多100条），已完成AI使用已有摘要，其余使用原始description，分类统计注明当前返回样本窗口。不在同步请求中调用AI，不添加新链接、预测或参与条件。此事件摘要通过 API 按需查询。
- 管理员密码重置在服务器环境执行，scrypt重新散列、撤销全部Session、审计，不接受明文命令行密码。

## 日度国债数据的时间语义

U.S. Treasury只提供sourceDate（业务日期），没有可靠精确发布时间。market_observations.observedAt表示系统采样/首次可观察时刻，sourcePublishedAt未知保持null，delaySeconds=null，frequency=daily。最新值先按sourceDate再按观测时刻排序，避免刚补采旧月份覆盖较新日期。历史图表展示来源日期时明确不是发布时间。原始XML、entry、字段与sourceURL保留，可按采样时刻回放信息可得性，不可在业务日期凌晨假定当时已经发布。

## 每日 10:00 行情通知（2026-11-27）

Worker 在北京时间（Asia/Shanghai）10:00 汇总行情监控已保存的观测，向已配置并启用的通知渠道各投递一份。当日错过 10:00 时，恢复后按当日 10:00 的截止时间补发。数据库按模式、日期、渠道去重，通知与投递任务在同一事务中写入。通知中心记录各渠道的结果，Fixture 仅用于模拟验证。

盘中报价比较今天和昨天各自从北京时间零点到 10:00 的最后一笔可用观测，要求资产、来源及单位一致。日度参考数据按截止时刻已经采到的最新来源日期展示，与该来源日期的前一自然日比较。消息列出来源和观测时间或来源日期。相对涨跌幅为（本次值 − 前值）÷ 前值 × 100%，国债收益率另列基点差。缺少同口径观测或基数为零时，百分比显示为不可计算。该通知独立于事件摘要接口和机会提醒规则。
