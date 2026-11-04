# 黄金与原油来源只读诊断

设计日期：2026-11-04。生产页面显示黄金网络错误后熔断、EIA 原油 HTTP 406，仅凭汇总错误还不能确定服务器的 DNS、TLS、出口网络或 HTTP 协商原因。

`infra/scripts/diagnose-market-sources.mjs` 使用 Node 24 内置 HTTPS，固定请求 `api.gold-api.com/price/XAU` 一次、`www.eia.gov/opendata/bulk/PET.zip` 两次。EIA 两次仅分别使用 `Accept: application/zip` 和 `Accept: */*`，其他请求头保持一致，便于判断 406 是否与 Accept 协商有关。请求使用和适配器相同的 User-Agent，不跟随重定向、不重试，收到响应头后立即停止，不读取或输出响应正文。

脚本为每次请求记录 DNS 查询、TCP 连接、TLS 握手和 HTTP 头部阶段的状态及耗时，每个请求总超时 12 秒、全程最多 36 秒网络等待。输出只包含固定探测名、官方主机名、阶段、状态、耗时、HTTP 状态码和白名单错误码；不打印错误 message/stack、IP、响应头、响应正文或环境变量，也不读取应用凭据。不改变数据库、checkpoint、熔断状态或生产配置。

在仓库目录执行：

```bash
docker compose exec -T worker node --input-type=module < infra/scripts/diagnose-market-sources.mjs
```

原始 JSON 行可直接用于比较两个 EIA 请求。`http` 阶段有状态码表示该请求已经完成 DNS/TCP/TLS；DNS 成功后 TCP/TLS 失败，可进一步在服务器检查出口策略、IPv4/IPv6 路由或证书环境。单次成功仅证明当时可达，不代表行情新鲜或供应商持续可用。此诊断使用 Node 内置 HTTPS 的直连路径，未配置代理；若生产另行使用代理，应结合相应出口配置单独核查，脚本不显示代理地址或凭据。
