# 11 · 预警与通知设计

设计版本：1.0 · 2026-11-02。

## 1. 四级预警与决策

P0 紧急且已验证的重大事故/基础设施故障；P1 可信的早期参与开放/关键阶段变化；P2 重要经济数据或市场异动；P3 普通资讯。severity、priority、confidence、opportunityScore、riskScore 独立。用户规则限定资产/类别/阈值/风险/置信度/渠道/时间窗/冷却。未验证资产可进入观察列表，但必须显示未知与风险，不凭社交热度触发“高可信机会”。

决策保存：匹配规则版本、输入快照、条件解释、冷却窗口、选择渠道、发送/抑制原因。高风险必须突出，不能被机会分抵消。价格异常需真实采样和明确窗口，收益率变化用 bps，不能与价格百分比混算。

## 2. Provider

统一 `send(message, channelConfig)` 返回 `accepted`、platformMessageId、acceptedAt、retryable、retryAfter。Telegram Bot、飞书 Bot、Bark 在通知中心配置；环境变量作为初始默认，页面保存凭据后由后续发送任务读取服务端加密配置。Token/设备 Key/Webhook 不回显，页面仅显示配置状态和非密钥 Chat ID；空白保留、明确清除后不回退环境密钥。支持 plain text/受控转义格式，避免来源正文注入平台格式；消息长度上限截断并附站内详情 URL。凭据损坏时保留可编辑的安全视图，实际发送记录 FAILED 并释放租约。

## 3. 数据库状态机

PENDING → SENDING → SENT；可重试失败 SENDING→RETRYING→SENDING；次数耗尽 FAILED；禁用或撤销 CANCELLED。SENDING 必须有 lease/startedAt，崩溃可回收。SENT 仅表示平台接口接受，UI 文案为“平台已接受”，不能表示已阅读/保证终端收到。超时发生在请求发送后时结果可能未知，attempt 必须说明该不确定性。

通知 dedupKey = hash(ownerId + ruleVersion + event/signal + channel + cooldownWindow)。插入唯一键确保并发命中只生成一条。平台不支持幂等键时仍存在响应丢失后重复发送窗口，保留所有尝试用于追踪。渠道禁用后停止投递待发消息，重新启用不会自动爆发发送过期信息。

## 4. 队列与恢复

待发送记录与规则命中同事务写入；outbox 扫描补投 BullMQ。429 按 Retry-After，5xx/网络指数退避，401/403 标记配置错误停止重试。单渠道速率限制在共享 Redis，不在各实例独立睡眠。对同频道突发 P2/P3 可聚合摘要；P0/P1 不等待 AI。人工测试消息独立限流且记录审计，默认不会在 Fixture 模式自动向真实渠道发送。

## 5. 模板 v1

标题/资产/项目、事件和发现时间、优先级、置信度、阶段、关键变化、评分依据、风险、官方来源及详情链接。早期机会额外有 firstSeenAt、参与窗口是否已验证、指标来源与时间、费用未知标记。禁止插入未经证据验证的参与地址、签名 URL 或 AI 新造链接。通知中保留 Fixture/延迟数据标识。

## 6. 配置与偏好

规则级 cooldownSeconds、允许推送小时范围、时区、最低优先级、风险过滤、enabled channel。跨午夜窗口必须正确处理；P0 是否绕过静默时段需明确配置，默认尊重用户设置。所有配置经 Zod 校验并保留版本。用户手动 retry 只复用现有通知，不创建新键绕过去重。
