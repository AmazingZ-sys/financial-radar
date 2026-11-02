# 研究复核、每日摘要与配置补充

2026-11-02，设计与实现补充。API注册在research-routes.ts，沿用统一鉴权、输入/输出Schema、CSRF/Origin和审计。

- POST /api/v1/events/{id}/review：APPROVED/REJECTED + 可选note，仅在AI分析完成后允许；保存reviewerId/reviewedAt，不改变verificationStatus、分数、原始指标或链上事实。
- GET /api/v1/projects/{id}/metrics：最多500条原始指标观测，来源和时间均保留，不进行虚构插值。
- GET /api/v1/digests/daily?day=YYYY-MM-DD：按UTC日首次观察时间汇总已保存事件（最多100条），已完成AI使用已有摘要，其余使用原始description，分类统计注明当前返回样本窗口。不在同步请求中调用AI，不添加新链接、预测或参与条件。本版没有自动每日外发订阅，通知仍由事件规则触发。
- 管理员密码重置在服务器环境执行，scrypt重新散列、撤销全部Session、审计，不接受明文命令行密码。

## 日度国债数据的时间语义

U.S. Treasury只提供sourceDate（业务日期），没有可靠精确发布时间。market_observations.observedAt表示系统采样/首次可观察时刻，sourcePublishedAt未知保持null，delaySeconds=null，frequency=daily。最新值先按sourceDate再按观测时刻排序，避免刚补采旧月份覆盖较新日期。历史图表展示来源日期时明确不是发布时间。原始XML、entry、字段与sourceURL保留，可按采样时刻回放信息可得性，不可在业务日期凌晨假定当时已经发布。
