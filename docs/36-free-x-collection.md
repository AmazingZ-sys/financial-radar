# 36 · 零数据 API 费用的 X 自建采集

设计日期：2026-11-05。用户最新约束覆盖35中的官方API选择：信息采集预算为0，接受自建并使用自己授权的X登录态。不得自动调用官方或第三方付费数据服务，AI分析费用与采集分开。

## 架构与边界

- Vue/Hono/PostgreSQL/Redis业务栈保持原有结构；增加独立Python采集容器，使用开源twscrape读取授权账号可见的公开帖子。只使用一个管理员授权会话，不购买账号、代理，不做验证码绕过或无限重试。
- API/Worker只访问服务器环境配置的`X_COLLECTOR_URL`，默认内部`http://x-collector:8080`。采集服务要求服务器侧`X_COLLECTOR_SECRET`共享密钥，容器端口不发布到公网。禁止请求重定向，设置超时与响应体上限。
- 管理页保存`sessionCookies`（仅auth_token和ct0），服务端加密存储、不回显；清除后停用，测试/日志/错误不包含登录态。旧官方Bearer凭据不转换成登录态，不触发官方请求。
- 采集器`POST /v1/search`：JSON `{query,sessionCookies,maxResults,sinceId?,startTime?,endTime?,beforeId?}`，共享密钥用`Authorization: Bearer`。返回`{posts:[{id,text,authorId,createdAt,originalUrl,hashtags,cashtags,referencedPosts}],hasMore}`。只返回真实源数据，缺少作者或发布时间不推测补齐。
- 采集器按查询时间/ID边界分页；Worker游标保存窗口、最高ID和下一页beforeId，持久批次在检查点之前落库。账号/关键词范围变化隔离游标。单次返回10..100条，查询与采集频率仍有本地每日请求上限；该计数不是费用。
- 默认关闭、600–1200秒随机间隔、每日96次；区间与持久请求门禁见 [37 随机采集](37-x-random-polling.md)。连接测试使用同一免费采集器且不调用AI、不生成业务事件，并共用下一次允许时间；fixture明确skipped且不访问网络。限流按较晚的冷却时间暂停；登录失效暂停并提示更新登录态。网络或结构错误不得切换付费服务。
- 35中的帖子去重、讨论聚合、证据时间、多作者原创门槛、同主题6小时冷却、AI日调用上限与通知隔离继续适用。

## 管理页与部署

管理页显示“自建免费采集 / 无数据API费用”，提供登录态更新/清除、关注账号、关键词、间隔、每日请求数、测试样本、最近错误及步骤。说明需要已有服务器资源，不承诺零基础设施成本或全量实时覆盖。账号可能限流、掉登录；失效显示未配置/失败，不冒充无热点。

步骤：部署内部采集容器并设置相同共享密钥 → 在X浏览器登录自己的授权账号 → 从浏览器开发者工具Cookies取auth_token与ct0（不发到聊天、不写URL）→ 管理页填`auth_token=...; ct0=...`并保存 → 连接测试 → 启用并查看来源状态。

验收需要覆盖：无官方/第三方API出站路径；凭据加密/不回显；未配置、fixture、清除、限流与失败；自建响应/分页/重复检测；PostgreSQL聚合/通知与AI预算；管理页保存重载和移动端。没有真实登录态时只能声明本地合成验证通过，不声明X已接通。

核验：[twscrape项目](https://github.com/vladkens/twscrape)。本方案不依赖Thunderbit、Apify或付费API。
