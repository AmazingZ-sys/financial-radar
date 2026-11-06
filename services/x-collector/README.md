# X 内部自建采集器

本服务使用 `twscrape==0.20.1` 和管理员自己授权的 X 登录态读取公开网页搜索。没有官方付费 API、第三方数据服务、AI 抽取、代理购买或账号池轮换。已有服务器资源及网络仍有运行成本；X 网页接口可能变化、限流或使登录失效，不保证实时或完整覆盖。

## 接入

1. 使用本项目的新版一键部署脚本，随 API/Worker 拉取并启动同版本的 `x-collector` 镜像，无需在服务器安装 Python。未配置 `X_COLLECTOR_SECRET` 时，脚本自动生成共享密钥并保存到服务器 `.deploy/x-collector.secret`（0600），三个服务使用相同值；已有环境配置优先。API/Worker 的 `X_COLLECTOR_URL` 默认 `http://x-collector:8080`。
2. 浏览器登录自己的授权 X 账号，在开发者工具 Application / Storage → Cookies → `https://x.com` 复制 `auth_token` 与 `ct0`。
3. 系统管理 → X 讨论监测填写 `auth_token=值; ct0=值`。不要把登录态发进聊天、写入 URL、提交 Git 或给其他人。
4. 保存关注账号、关键词、间隔和本地每日请求上限；先测试，再启用。测试不会调用 AI。更新或清除登录态同样通过管理页完成。
5. 401 提示更新登录态；429 按返回的冷却时间暂停；502/504 检查版本/网络。失败不会切换到付费服务。Fixture 在业务 API/Worker 跳过采集，不把合成数据当作真实 X 联通。

采集任务在管理页配置最短与最长间隔，默认600–1200秒（10–20分钟）。每次真实调用前在数据库锁内抽取并保存下次时间；刷新、重启和保存配置不重置等待，手动测试也共用限制。限流可延后到区间之外，随机间隔不保证避免账号限制。此区间控制本地任务调用，单次任务可能有多个网页请求。

首次从旧版升级，需要先将服务器仓库更新到包含三镜像部署功能的已发布版本（将 `vX.Y.Z` 替换为实际 Release）。保留原 `.env`、`deploy.env`、`.deploy` 与数据卷：

```sh
cd /opt/financial-radar
sudo git fetch --tags origin
sudo git switch --detach vX.Y.Z
sudo bash infra/scripts/deploy.sh --version vX.Y.Z
```

之后更新继续使用 `sudo bash /opt/financial-radar/infra/scripts/deploy.sh`，自动选择镜像发布完整的稳定版本。采集器镜像名为 `ghcr.io/amazingz-sys/financial-radar/x-collector:vX.Y.Z`，部署按 Release 的不可变 digest 拉取；不在服务器 build 或 pip install。切换真实采集需要服务器 `DATA_MODE=live`；Fixture 只做明确标记的合成验证。

服务仅监听容器内部 `8080`，没有宿主端口映射，因此不占用服务器 `8888` 或其他端口，也不需要新增 Nginx 站点或开放防火墙。容器之间的同名端口互相独立。脚本会等待采集器健康，失败按原部署策略恢复应用；历史双镜像版本继续可用，回滚历史版本保留已有采集器容器。

如需手工管理共享密钥，可在原 `APP_ENV_FILE` 对应文件中设置 `X_COLLECTOR_SECRET`（至少32字符，无空白）及 `X_COLLECTOR_URL=http://x-collector:8080`，再运行部署脚本。不要直接用普通 `docker compose up` 覆盖脚本管理的应用，因为它不会加载 `.deploy` 中的版本、digest 与自动生成密钥。备份 `.deploy` 时按机密配置保护。

本地开发可用 `docker compose -f docker-compose.dev.yml --profile x-free up -d --build x-collector`，API/Worker环境改为 `X_COLLECTOR_URL=http://127.0.0.1:18080` 并使用相同共享密钥。此端口只绑定本机回环地址。首次环境配置需重启API/Worker，之后更新X登录态和关注账号不需要重启。

## 内部契约

`POST /v1/search`，`Authorization: Bearer <X_COLLECTOR_SECRET>`，JSON 字段：`query`、`sessionCookies`、`maxResults`、`endTime`，以及二选一的 `sinceId` / `startTime`；后续页带 `beforeId`。只接受管理端生成的字面账号查询；固定 ID/时间边界转换为网页搜索的 `since_id` / `max_id`，按 Latest 获取至多 `maxResults+1` 个模型判断是否存在下一页。单个本地采集请求可能读取多个网页响应，今日请求数是本地调用数，不是 X 服务费用或上游 HTTP 次数。

响应 `{posts:[{id,text,authorId,createdAt,originalUrl,hashtags,cashtags,referencedPosts}],hasMore}`；正文、作者、时间缺失时失败，不补造字段。Worker 验证返回证据的边界，保存固定 `endTime` 与严格递减的 `beforeId`，最后一页落库后再推进最新 ID。

一次只处理一个授权会话；每次临时 SQLite 用后删除，容器 `/tmp` 应配置 tmpfs，不挂载账号持久卷。数据库中的登录态由业务服务加密保存。关闭 twscrape 遥测与上游日志；直接传输禁用代理、重定向、传输层重试，白名单仅 `x.com`、`www.x.com`、`abs.twimg.com`，不接受官方 `/2/` 或第三方付费地址。twscrape 内部有有限失败处理，外层15秒硬超时；429 保留冷却，不等待或换账号绕过限制。没有验证码处理或自动登录流程。

## 验证

`python -m unittest discover -s services/x-collector -p 'test_*.py' -v` 使用本地桩与回环 HTTP，不使用真实 Cookie，不访问 X。安装依赖后还可执行 transport/API 契约测试。真实联通需部署后在管理页使用自己的授权登录态测试。

来源：[twscrape 项目](https://github.com/vladkens/twscrape)、[固定 v0.20.1 API](https://github.com/vladkens/twscrape/blob/v0.20.1/twscrape/api.py)、[Cookie API](https://github.com/vladkens/twscrape/blob/v0.20.1/twscrape/accounts_pool.py)。
