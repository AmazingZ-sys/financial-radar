# 黄金与 WTI 数据源故障恢复

设计日期：2026-11-04；先于本次实现。

## 已知证据与边界

- 生产来源健康记录显示黄金从未成功，最近错误为“数据源网络错误或超时”，随后进入熔断；旧 HTTP 包装丢弃底层 `cause.code`，目前不能区分 DNS、TLS、连接、重定向或超时，不能把“网络错误”直接当作供应商停服。
- 生产 WTI 健康记录出现 HTTP 406，随后进入熔断；406 是响应拒绝，不是行情为空。当前只接受 `application/zip`，但 EIA 本地只读 HEAD 实测返回 `application/x-zip-compressed`。不能以此单点测试断言线上 406 一定由 Accept 导致，需用兼容接受头修复并在服务器复验。
- 本地主机使用 Node 默认网络时 EIA 连接报 `ETIMEDOUT`；curl 经已配置代理可访问。网络出口不同，不能把本地主机通路等同生产环境。黄金本地公开端点可返回 200，不能据此断言生产已恢复。
- 不切换 sourceId，不用 Fixture 或别的供应商补值；WTI 仍为 EIA 官方日度 `PET.RWTC.D`，黄金仍为 Gold API `XAU`。现有 sourcePublishedAt、sourceDate 和发现时间语义不变。

## 实现约定

1. WTI 请求接受 EIA 官方实际媒体类型 `application/x-zip-compressed`、标准 `application/zip`、二进制类型及低优先级通配类型；仍校验 ZIP 结构、目标序列、单位、日期、数量/字节/时间上限，禁止把 HTML 错误页面当价格。
2. HTTP 网络错误只附加白名单诊断代码（DNS/TLS/连接/超时/重定向），绝不拼接原始错误 message、URL、主机、请求头、key 或代理配置；保留错误分类。熔断提示携带上一次安全原因及剩余冷却时间，让健康记录可解释。
3. 既有 Retry-After 和有限退避不被覆盖；熔断冷却使用最大值，避免连续失败缩短供应商要求的冷却。失败响应主动取消 body，释放连接。
4. 来源 schema 与读取失败不推进 cursor；HTTP 406 保留为永久响应错误，等待后续正常轮询/人工修正，而非伪造成功。半开探测成功后清除失败原因与熔断状态。

## 验收

- 单元测试覆盖 EIA 请求 Accept、条件请求、ZIP/日期/单位边界；HTTP 白名单诊断与密钥脱敏、熔断中保留根因、冷却不缩短、半开恢复。
- `scripts/commodity-recovery-integration.ts` 使用真实 PostgreSQL、随机 Fixture sourceId 和合成报价；验证 HTTP 406 / ENOTFOUND 不写行情事实、不推进 cursor，安全错误可见，恢复成功后 raw/market 幂等。该脚本不访问 live 凭据，不宣称生产恢复。
- 主工作流运行 typecheck、lint、test、build 及相关集成测试，在 `docs/acceptance.md` 记录执行结果。生产是否恢复以更新后的真实 Worker 成功记录为准。

## 官方依据

- [Gold API FAQ](https://gold-api.com/faqs)：公开最新报价无需 key；每 30 秒更新；`updatedAt` 为供应商取得数据时间。
- [EIA bulk facility](https://www.eia.gov/opendata/v1/bulkfiles.php)：ZIP 包含同名 TXT；TXT 每行完整 JSON；序列按最近更新时间排序。
