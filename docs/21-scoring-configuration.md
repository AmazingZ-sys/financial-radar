# 评分配置补充设计

2026-11-02。评分权重是独立的机会和风险配置，每套包含不可复用的version和已知维度权重；输入Zod严格验证、非负有限值、至少一个权重>0。更新不重算历史，Worker在处理新事件时读取配置，并保存当时version/breakdown。

GET /api/v1/system/scoring返回当前配置；PATCH 同路径只允许管理员，完整输入、CSRF、Origin、审计。某部分权重变化必须新版本号，且版本号不能与该部分历史冲突；用事务advisory lock串行化；历史快照存system_settings namespaced key（scoring-history:...）。默认版本首次读取即保存基线，以便未来追溯。无配置时使用经过测试的默认值，不用AI决定权重。

风险严重标记硬性下限（85）独立于可配置权重；机会分再高不抵消该下限。配置错误使写接口拒绝，Worker记录问题而非悄悄采用高分。
