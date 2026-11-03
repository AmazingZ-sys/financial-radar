# 26 多领域新闻订阅目录

设计与核验日期：2026-11-03。此文件先于本轮新闻实现。

新增来源使用真实 RSS，而非虚构行情或搜索热榜。预置 ECB 政策公告、BBC 全球、财经、科技新闻。已有 Fed 官方公告与美国财政部日度利率继续提供宏观视角；加密适配器保留。页面以宏观政策、财经市场、科技动态、全球热点、加密资产分类。

## 官方资料与接入范围

- [ECB 官方 RSS 目录](https://www.ecb.europa.eu/home/html/rss.en.html)直接链接 `https://www.ecb.europa.eu/rss/press.html`，包含新闻稿、演讲、采访和记者会文字。保留官方原文链接与来源日期；不将演讲发布时间等同于货币政策生效时间。
- [BBC 官方开发者 Feed 说明](https://support.bbc.co.uk/platform/feeds/NewsFeeds.htm)明确存在官方 RSS 与 Feed 使用条款。[BBC 官方条款](https://downloads.bbc.co.uk/usingthebbc/bbc_terms_of_use_19September2022english.pdf)说明商业使用需要许可。使用 BBC 自有 `feeds.bbci.co.uk` 的 `/news/world/rss.xml`、`/news/business/rss.xml`、`/news/technology/rss.xml`，仅保存标题、摘要、原文链接，默认单管理员内部研究；商业再分发须另获许可。公开订阅不能证明全部报道均真实，新闻事件保持 UNVERIFIED。
- 上述资料核验不等同于生产网络连通、许可授权或延迟 SLA。来源无固定免费实时承诺，默认新闻五分钟轮询，ECB 两分钟轮询，系统显示轮询周期与未知端到端延迟。

## 自定义来源契约

管理员提交名称、公开 HTTPS RSS/Atom 地址、分类、轮询周期、启用状态。Feed URL 不允许 URL 凭据、查询参数、片段；不支持密钥订阅与登录抓取。保存时 DNS 检查，采集时再次以固定解析地址请求，拒绝私网和重定向。每条仅保留 Feed 自带摘要，不抓取全文。新增订阅保存在 `data_sources.data.feedConfig`，来源类型 `custom=true`，使用 UUID 后缀 ID；同一端点重复添加幂等。

来源地址不可通过启停接口更换，避免历史证据被重新归因。Worker 每 15 秒从 PostgreSQL 同步新增来源和启停；已有历史来源记录保留。Fixture 可查看 live 目录但禁止新增 live 采集源，且不会在 Fixture 采集中访问真实新闻。

XML 限制 2MB、500 条目、字段长度；拒绝 DTD/实体声明、畸形 XML 和非 RSS/Atom；无来源发布时间则保留 null。Raw item 原始内容及来源 ID 参与持久化，条目 ID 或链接提供去重键。RSS/Atom 来源不隐含完整历史。

## 本地连通性证据

2026-11-03，Python urllib 经当前环境网络路径读取四个官方端点均返回 HTTP 200 并解析为 RSS：ECB 15 条、BBC 全球 35 条、财经 52 条、科技 21 条（计数仅代表当次窗口）。实际 Node 24 `fetchPublicHttps` + `NewsRssConnector` 路径验证 ECB 成功读取 15 条且保留来源时间；BBC 三个端点在本机直接 HTTPS 路径失败，系统 DNS 将其解析到拒绝连接的地址。尚不能据此声称 BBC 在 Worker/生产可用。保留来源原地址与真实降级状态，不绕过网络限制，不回退合成数据；生产需在实际部署服务器验证 DNS 与外网连接。
