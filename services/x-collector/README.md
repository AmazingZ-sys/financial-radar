# X 内部自建采集器

本服务使用 `twscrape==0.20.1` 和管理员自己授权的 X 登录态读取公开网页搜索。没有官方付费 API、第三方数据服务、AI 抽取、代理购买或账号池轮换。已有服务器资源及网络仍有运行成本；X 网页接口可能变化、限流或使登录失效，不保证实时或完整覆盖。

## 接入

1. 在 Compose 内部网络启动 `x-collector`；不要向宿主机或公网发布 8080 端口。API、Worker、采集器设置相同的服务器环境变量 `X_COLLECTOR_SECRET`，随机生成至少32字符；API/Worker 的 `X_COLLECTOR_URL` 默认 `http://x-collector:8080`。
2. 浏览器登录自己的授权 X 账号，在开发者工具 Application / Storage → Cookies → `https://x.com` 复制 `auth_token` 与 `ct0`。
3. 系统管理 → X 讨论监测填写 `auth_token=值; ct0=值`。不要把登录态发进聊天、写入 URL、提交 Git 或给其他人。
4. 保存关注账号、关键词、间隔和本地每日请求上限；先测试，再启用。测试不会调用 AI。更新或清除登录态同样通过管理页完成。
5. 401 提示更新登录态；429 按返回的冷却时间暂停；502/504 检查版本/网络。失败不会切换到付费服务。Fixture 在业务 API/Worker 跳过采集，不把合成数据当作真实 X 联通。

采集任务在管理页配置最短与最长间隔，默认600–1200秒（10–20分钟）。每次真实调用前在数据库锁内抽取并保存下次时间；刷新、重启和保存配置不重置等待，手动测试也共用限制。限流可延后到区间之外，随机间隔不保证避免账号限制。此区间控制本地任务调用，单次任务可能有多个网页请求。

在原部署环境文件中增加 `X_COLLECTOR_URL=http://x-collector:8080` 和 `X_COLLECTOR_SECRET`（可用 `openssl rand -hex 32` 自行生成）。保留原有版本、数据库及其他配置，在仓库根目录执行：

```sh
docker compose --profile x-free up -d --build x-collector
docker compose up -d --force-recreate api worker
```

原部署若使用 `--env-file`，以上两条命令沿用同一个文件。切换真实采集需要服务器 `DATA_MODE=live`；Fixture只做明确标记的合成验证。上述命令不会删除数据库卷。服务仅监听容器内部8080，无宿主端口。

本地开发可用 `docker compose -f docker-compose.dev.yml --profile x-free up -d --build x-collector`，API/Worker环境改为 `X_COLLECTOR_URL=http://127.0.0.1:18080` 并使用相同共享密钥。此端口只绑定本机回环地址。首次环境配置需重启API/Worker，之后更新X登录态和关注账号不需要重启。

## 内部契约

`POST /v1/search`，`Authorization: Bearer <X_COLLECTOR_SECRET>`，JSON 字段：`query`、`sessionCookies`、`maxResults`、`endTime`，以及二选一的 `sinceId` / `startTime`；后续页带 `beforeId`。只接受管理端生成的字面账号查询；固定 ID/时间边界转换为网页搜索的 `since_id` / `max_id`，按 Latest 获取至多 `maxResults+1` 个模型判断是否存在下一页。单个本地采集请求可能读取多个网页响应，今日请求数是本地调用数，不是 X 服务费用或上游 HTTP 次数。

响应 `{posts:[{id,text,authorId,createdAt,originalUrl,hashtags,cashtags,referencedPosts}],hasMore}`；正文、作者、时间缺失时失败，不补造字段。Worker 验证返回证据的边界，保存固定 `endTime` 与严格递减的 `beforeId`，最后一页落库后再推进最新 ID。

一次只处理一个授权会话；每次临时 SQLite 用后删除，容器 `/tmp` 应配置 tmpfs，不挂载账号持久卷。数据库中的登录态由业务服务加密保存。关闭 twscrape 遥测与上游日志；直接传输禁用代理、重定向、传输层重试，白名单仅 `x.com`、`www.x.com`、`abs.twimg.com`，不接受官方 `/2/` 或第三方付费地址。twscrape 内部有有限失败处理，外层15秒硬超时；429 保留冷却，不等待或换账号绕过限制。没有验证码处理或自动登录流程。

## 验证

`python -m unittest discover -s services/x-collector -p 'test_*.py' -v` 使用本地桩与回环 HTTP，不使用真实 Cookie，不访问 X。安装依赖后还可执行 transport/API 契约测试。真实联通需部署后在管理页使用自己的授权登录态测试。

来源：[twscrape 项目](https://github.com/vladkens/twscrape)、[固定 v0.20.1 API](https://github.com/vladkens/twscrape/blob/v0.20.1/twscrape/api.py)、[Cookie API](https://github.com/vladkens/twscrape/blob/v0.20.1/twscrape/accounts_pool.py)。
