# 18 风险、依赖与上线前检查

创建日期：2026-11-02。状态由实际验收持续更新；设计阶段识别记录如下。

| ID  | 风险/依赖                             | 影响                               | 首版处理                                                        | 关闭证据                                     |
| --- | ------------------------------------- | ---------------------------------- | --------------------------------------------------------------- | -------------------------------------------- |
| R01 | 全链部署/铸造/参与数据需要索引器      | 不能保证全部新项目首次出现均被捕获 | 能力 descriptor 声明范围；授权接口+Fixture；默认不冒充 live     | 合同、真实 API 样本、checkpoint重连/重组测试 |
| R02 | FRED 当前 AI 与缓存/存储限制          | 影响原始数据入库与 AI              | live 默认禁用，直连原始官方宏观源                               | 覆盖具体用途的书面许可                       |
| R03 | Coinbase / DEX 等数据分发许可         | 公开多用户服务可能不在范围         | 默认私有单管理员；记录许可状态                                  | 商业/再分发书面许可与归属要求                |
| R04 | ORDI 历史缺原始可知时间证据           | 不能证明当年可发现，不能做收益承诺 | 通用 availableAt 回放，Fixture单独标记                          | 已核验铭文/区块/公告/索引器/价格证据包       |
| R05 | AI 幻觉/Prompt注入                    | 可能虚构来源或参与条件             | 证据ID白名单，结构校验，推断与事实分离，不生成参与签名链接      | 不合法 evidenceId / provider不可用测试       |
| R06 | Telegram 平台接受不等于阅读           | 误报送达保证；网络超时可能已发送   | SENT含义为平台接受；attempt保存receipt；重试可能重复需说明      | 真实 bot chat测试、超时故障注入              |
| R07 | DB事务与Redis入队之间中断             | 丢消息或重复处理                   | PostgreSQL outbox，稳定jobId，业务唯一约束，reconciler          | 中途重启/重复任务集成测试                    |
| R08 | 队列重启/worker断电                   | 采集缺口、stalled task             | 持久 cursor、有限重试、死信保留、心跳                           | Redis/Worker恢复测试                         |
| R09 | 配额/封禁/网络                        | 数据过期                           | respect Retry-After、超时、退避、熔断、freshness展示            | 模拟429/5xx/超时与过期测试                   |
| R10 | 密钥/管理员密码暴露                   | 未授权访问、额度损失               | 环境注入、哈希、脱敏、Cookie/CSRF、限流、审计                   | 安全检查和鉴权测试                           |
| R11 | 迁移与应用回滚不兼容                  | 无法恢复业务                       | expand-only初始迁移，先备份，记录上一个健康版本，不自动反向迁移 | 数据库恢复演练与应用回滚记录                 |
| R12 | GHCR、Netlify、DNS、TLS、服务器未提供 | 无法实际对外发布                   | 交付 workflow/scripts/examples，外部步骤标阻塞                  | 真实 CI Release URL、镜像digest、线上health  |
| R13 | 官方页面/接口更新                     | 静默解析错误                       | schema validation、raw quarantine、官方文档复核                 | 定期契约检查与可观测错误样本                 |
| R14 | 经济数据修订/日度与实时混淆           | 未来信息泄漏、假实时               | vintage/availableAt；未知时间null；频率和来源显式展示           | 回放未来数据被排除测试                       |
| R15 | 高频指标膨胀                          | 性能/费用失控                      | retention、按月归档/分区演进、查询限页                          | 压测与备份体积记录                           |

## 外部配置登记

- PostgreSQL / Redis：本地 Docker 支持情况由实际启动确认；生产连接只接受安全环境注入。
- Telegram：BOT_TOKEN、CHAT_ID；没有密钥时 provider 返回配置缺失，Fixture模拟发送不得记成真实成功。
- LLM：endpoint/model/key 与明确预算；未配置时规则继续运行，AI显示 disabled/degraded。
- GitHub：可无 token 运行单仓慢轮询，生产多仓需授权 token；仓库白名单由管理员确认官方归属。
- UniSat / EVM / Helius：需要账户套餐及合法用途，默认禁用未配置连接。
- 黄金/原油授权实时行情：未授权则 unavailable，禁止静态价格伪装实时报价。
- GitHub Actions 发布：GHCR packages write、release contents write、Netlify token/site id；不能把模拟 workflow 当真实发布验收。

## 运行责任边界

系统只做信息监控与研究辅助，不管理私钥、不自动交易、不签名。未知资产风险独立展示；无可信证据的参与条件为 unknown。上线后需根据真实延迟、误报漏报和告警噪声调参，不能承诺捕获所有机会或保证收益。
