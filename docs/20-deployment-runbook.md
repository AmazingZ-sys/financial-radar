# 部署、发布与恢复操作手册

更新：2026-11-06。本文与 `infra/scripts`、Compose、GitHub workflow 一起维护。脚本测试使用 fake executables，不代表在真实服务器执行成功。

新版发布将 Python X 采集器纳入同版本镜像与一键部署，服务器无需安装 Python。旧服务器先更新 Compose 和部署脚本到目标 Release，再执行原 `deploy.sh`。采集器只使用 Docker 内网 `8080`，不占用宿主 `8888`，不需要新增端口或 Nginx 站点。未配置共享密钥时自动生成并保存在 `.deploy/x-collector.secret`（0600）；X 授权登录态仍须在管理页保存、测试后启用。完整步骤与旧版兼容边界见 [采集器部署](../services/x-collector/README.md) 和 [设计39](39-x-collector-image-deployment.md)。下文的四服务验收属于历史证据，新版实际结果记录在 `acceptance.md`。

当前生产域名为前端 `radar.amazingzsys.site`、后端 `api.radar.amazingzsys.site`。按实际域名执行首次部署，请阅读 [Ubuntu 22.04/24.04 详细步骤](24-server-api-radar-amazingzsys-site.md)；本文继续说明通用部署、持久状态与恢复机制。

## 1. 已验证与外部条件

本地验证覆盖 Compose 插值/Schema、Bash 语法、actionlint 1.6.27 静态校验与 22 项部署脚本测试，包含备份先于迁移、健康失败回旧应用、Nginx 校验失败不 reload、Release清单/版本/commit/digest与镜像标签校验、未完成Release跳过、私有资产下载失败保留当前版、Token不进入输出和旧部署记录补齐。另有 Node 24.15.0 隔离生产文件布局烟测。

Docker Desktop 启动后，已在 Docker Engine 29.9.2 上实际构建 API/Worker 镜像，并使用唯一的 `radar-acceptance-d3556adb2c5a` 项目对最终冻结代码复用生产 Compose 验收通过：四服务 healthy、随机特殊字符密码与 URL 编码、两次迁移、两次采集幂等、5 条原始项/5 条事件/4 个项目/4 条信号、生产管理员 Session/CSRF、安全 Cookie、非 root 应用、PG/Redis 容器替换后持久化，以及真实备份恢复到独立新库。日志和 result.json 保存在 `.local/docker-acceptance`；本次测试容器、网络与卷已清理，未触碰其他项目。

`infra/scripts/test-compose.sh` 将该流程作为可重复 CI gate：随机唯一项目、无主机端口、独立测试配置，只删除本次创建的资源与镜像。失败保留日志；若清理本身失败则返回非零并保留配置供定向清理。旧 test-images.sh 委托此脚本。镜像中不存在业务源码，只包含 dist、生产依赖与迁移文件。GitHub Actions、GHCR与Netlify的首次真实发布v1.0.0已完成，证据见 `23-release-and-update.md` 和 `acceptance.md`；这是原托管平台的历史记录。本次 Vercel 项目、凭据、实际发布与域名切换需单独验证，不能据旧记录声称迁移成功。宿主机Nginx/证书和目标服务器部署由用户另行验收，不能由容器或前端上线推断成功。

服务器需要 Linux、Docker Engine + Compose v2 或兼容版本、Bash、curl、jq、足够磁盘、可访问 GHCR/GitHub 及配置好的宿主机 Nginx。`NGINX_RELOAD=true` 时需要 `nginx -t` 与 `systemctl reload nginx` 权限。脚本不会自动安装软件、改 Nginx 配置、申请证书、删除数据库卷或重启 Nginx。

## 2. 生产配置

将工程的 Compose、迁移文件、infra/scripts 和受信任配置放在 `/opt/financial-radar`。复制 `infra/scripts/deploy.example.env` 为 `deploy.env`，其为**可执行 Shell 配置**，只允许运维用户写入，建议权限 0600。应用 `.env` 也设 0600，不提交或复制进镜像；`.dockerignore` 排除了 `.env*`、`deploy.env`、备份与本地状态。

从 `.env.example` 创建生产配置，替换管理员密码、Session Secret、PG/Redis 密码与 HTTPS Web Origin。Compose 强制 `NODE_ENV=production`、`SECURE_COOKIE=true`、容器 `PORT=3000`；宿主仅映射 `127.0.0.1:13000:3000`，Nginx upstream 与部署健康 URL 使用宿主 13000。容器内端口和本地开发仍为 3000，config 会拒绝示例管理员/数据库凭据。建议 Web `radar.example.com`、API `api.radar.example.com` 使用同注册域，`COOKIE_SAME_SITE=Lax`。当前生产继续使用 `radar.amazingzsys.site` 与 `api.radar.amazingzsys.site`，迁移到 Vercel 不修改后端 Origin、Cookie 或 CSRF 策略。临时 `vercel.app` 地址仅供静态验收，不加入生产允许源；完整认证验证安排在用户完成自定义域名映射之后。

**Compose 不拼接密码 URL。** 同时提供原始 `POSTGRES_PASSWORD` / `REDIS_PASSWORD` 给服务，以及带 URL 编码凭据的完整连接串：

```dotenv
POSTGRES_USER=radar
POSTGRES_DB=radar
POSTGRES_PASSWORD='a-unique-raw-password'
REDIS_PASSWORD='another-unique-raw-password'
DATABASE_URL='postgresql://radar:URL_ENCODED_PASSWORD@postgres:5432/radar'
REDIS_URL='redis://:URL_ENCODED_PASSWORD@redis:6379'
WEB_ORIGIN=https://radar.example.com
IMAGE_REPOSITORY=ghcr.io/your-lowercase-owner/financial-radar
APP_VERSION=v1.0.0
```

`@`、`:`、`/`、`%`、`#` 等必须以 encodeURIComponent 等标准方法编码一次；不能直接把 raw password 插入 URL。主机名必须为 Compose 服务 `postgres` / `redis`，不能沿用本地 127.0.0.1。密码含 `$` 时 `.env` 单引号避免 Compose 插值。`APP_ENV_FILE` 指向可信应用配置，容器 env_file 与 Compose interpolation 使用同一文件。不要将完整 `docker compose config` 输出发到日志；脚本只用 `--quiet`，或把 JSON 私密地管道至 jq 提取镜像名。

先运行：

```bash
APP_ENV_FILE=.env docker compose --env-file .env config --quiet
bash infra/scripts/check-nginx.sh
bash infra/scripts/deploy.sh --version v1.0.0
```

日常更新只需以下命令；无参数等同 `--latest`：

```bash
sudo bash /opt/financial-radar/infra/scripts/deploy.sh
```

脚本从GitHub Release列表选择最新稳定且已附上完整 `release-metadata.json`、`image-manifest.json` 资产的版本，跳过镜像仍在构建的Release，最多检查最近1000条。明确指定 `--version vX.Y.Z` 而资产缺失时安全失败并提示发布未完成；没有已完成版本也会退出，不替换当前应用。清单内容不合法时直接报错，不静默降级。公开镜像无需登录；私有镜像预先 `docker login ghcr.io`，或在受信任 `deploy.env` 提供 GHCR_USER/GHCR_TOKEN。私有 GitHub Release 需要服务器 GITHUB_TOKEN（仓库读取权限）；脚本通过GitHub资产API下载清单，认证不写入命令参数或输出。`--latest` 与指定版本均使用该认证。

首次在服务器检出本仓库、配置 `.env` / `deploy.env` 与Nginx后即可运行。日常应用镜像更新不要求 `git pull`。若某个Release修改了宿主Compose或部署脚本，先更新服务器仓库到目标Release；以下命令不会强制覆盖本地改动，已忽略的生产配置和 `.deploy` 状态保留：

```bash
cd /opt/financial-radar
sudo git fetch --tags origin
sudo git switch --detach vX.Y.Z
sudo bash infra/scripts/deploy.sh --version vX.Y.Z
```

将两处 `vX.Y.Z` 替换为同一已完成Release。检出因本地改动而被Git拒绝时先检查并保留改动，不能用强制reset绕过。脚本不远程下载并执行未知bootstrap代码，也不会自动更新宿主Nginx配置、证书或生产密钥。

从旧宿主 3000 端口迁移时，先确认 13000 空闲：`sudo ss -ltnp 'sport = :13000'`；若显示监听进程，应先查明占用并停止此次迁移。取得包含新映射的 v1.0.3 部署文件后，保留已有 `.env`、`deploy.env`、`.deploy` 与卷，手工将旧 `deploy.env` 中的 `HEALTH_URL` 改为 `http://127.0.0.1:13000/ready`，并将本项目已安装的 Nginx `proxy_pass` 改为 `http://127.0.0.1:13000`。先备份本项目站点、执行 `nginx -t`，然后运行部署脚本；脚本会在新端口健康后重载 Nginx。不要提前重载至尚未启动的新端口。具体迁移命令见 [实际域名指南第 9 节](24-server-api-radar-amazingzsys-site.md#9-已有部署从宿主-3000-迁移到-13000)。首次尚未部署时，直接采用新配置即可。

## 3. 应用更新事务与持久状态

部署锁为 `.deploy/lock`，同一时刻只允许一个 deploy/rollback/restore。进程异常退出可能留锁；先核对无运行部署，再人工删除空锁目录。脚本不会猜测或抢占锁。

部署顺序：选择已完成稳定Release → 下载并校验metadata/manifest的版本、相同40位commit与本仓库镜像digest → 直接按digest拉取镜像 → 校验全部镜像的revision/version标签均匹配Release → 解析或生成共享密钥 → 启动/等待 PG 与 Redis → 验证备份 → 单独 migrate 容器 → 启动/等待采集器健康（旧双镜像版本跳过）→ 更新 API/Worker（不重新创建依赖）→ HTTP ready、Worker 心跳与采集器健康 → `nginx -t` 后 reload → 原子保存已验证状态。高可用Nginx采用平滑reload，不无条件restart。

`.deploy/current` 为当前已验证版本，`.deploy/previous` 为前一版本，`.deploy/images/vX.Y.Z` 前三行依次为 API digest、Worker digest 与通过镜像标签校验的40位commit SHA；新版第四行为采集器digest，兼容历史三行记录。独立 backup/check-health 和后续操作会加载此状态，**不要求手动把新版本同步回旧 `.env`**。同一已验证版本再次部署使用已保存digest，即使发布重试生成新digest也保持原pin；同时复核保存状态的镜像仓库/target与Release清单一致、commit匹配，并重新校验实际拉取镜像的version/revision标签。请按机密配置备份 `.deploy`，其中可能包含自动生成的采集器共享密钥，不要手工改 image 记录。直接运行普通 `docker compose up` 不自动加载 `.deploy`，应使用提供的脚本。

若备份/迁移失败，旧应用不替换；迁移成功而新应用或 Nginx 检测失败时，恢复之前验证过的应用镜像集。首次安装没有旧版，停止失败的应用及采集器并保留数据库与日志。成功应用回滚**不等于数据库回滚**；DDL 必须保持 expand/contract 兼容。新版本首次发布前必须在测试环境验证旧版与新 Schema 兼容。

## 4. 备份、恢复和回滚

`backup.sh` 用同一 Compose PostgreSQL 容器中的 POSTGRES_USER/POSTGRES_DB 执行自定义格式 pg_dump；拒绝空档案，pg_restore --list 检查结构，保存 SHA-256 校验。失败清理临时档案。在线数据库备份仍需异地加密复制、保留周期与定期恢复演练，脚本不自动删除历史备份。

```bash
bash infra/scripts/backup.sh
bash infra/scripts/check-health.sh
bash infra/scripts/rollback.sh              # 上一个已验证 digest
bash infra/scripts/rollback.sh v1.0.0       # 必须有本机已验证镜像记录
bash infra/scripts/restore.sh /absolute/radar-backup.dump radar_recovery_20261102
```

restore 拒绝当前生产库名称；createdb 拒绝已存在数据库；校验 checksum 和 archive 后，仅恢复到明确的新库，绝不 DROP/clean/覆盖 live DB。恢复失败留下新库供检查，不擅自删库。运维应停止业务写入，在新实例或新库验证行数/约束/时间/管理员认证后，独立变更连接配置并健康检查。服务器数据损坏、完整灾备恢复与流量切换需要运维决策，脚本不自动执行。

rollback 更新所选版本已验证的镜像集，不迁移或恢复数据库。历史双镜像版本只替换 API/Worker，保留现有采集器与共享密钥；旧状态没有记录手工采集器的历史digest，不能据此还原其旧镜像。回滚版自身健康失败时尝试恢复当前应用，持久 current/previous 不改，并返回非零供人工处理。

## 5. GitHub 发布与故障重试

同一 workflow：verify → release → images(api/worker/x-collector matrix) → image-manifest → vercel。前端 job 显式依赖 `release`、`images`、`image-manifest`，三个镜像都成功后才上传清单。Release job 内 semantic-release 输出版本与 commit，镜像与 Web checkout **该 commit**；不靠自动创建 tag/release 触发另一个普通 workflow。这遵循 [GitHub 的 GITHUB_TOKEN 事件限制](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。pnpm Docker 运行依赖保留 workspace symlink 图，参考 [pnpm Docker 文档](https://pnpm.io/docker)。

Conventional Commits 计算版本；只在 main 发布，无语义版本变化时 images/Vercel 跳过。Release 生成 Git Tag、GitHub Release、CHANGELOG.md 和 release-metadata.json 资产。为避免机器人写 main，累计 CHANGELOG 从上次 Release 资产恢复后继续生成；仓库里的静态 CHANGELOG 不被自动提交，权威累计文件以 Release 资产为准。三个镜像包含 OCI version/revision/created/source，GHCR 使用 vX.Y.Z 与 sha-commit，不依赖 latest。image-manifest.json 记录不可变摘要并附同一 Release。

若 Release 已创建，但镜像或 Vercel 步骤失败，先使用 GitHub“Re-run failed jobs”重试；也提供 workflow_dispatch，输入现有稳定 vX.Y.Z。该路径先检出 tag 做完整验证，再确认对应 Release 非草稿/预发布，把 tag commit 输出给镜像/Web jobs。不会再次让 semantic-release 计算新版本。该重试会使用目标 tag 的部署文件；迁移前的旧 tag 仍包含 Netlify 配置，不能用它验证 Vercel 迁移。GHCR 同一 tag 的重建仍可能因上游 base image/tag 更新产生新 digest；生产已保存 digest 不会自动跟随。若需要复现位级产物，应固定基础镜像 digest 并使用首次 Release receipt，当前未提供供应链签名保证。

仓库必须配置 Actions permissions、GHCR package 写入权限、production Environment，以及 `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID` Secrets 与公开 `VITE_API_BASE_URL` Variable。Vercel 项目 Root Directory 使用仓库根目录 `.`，Node.js 使用 24.x。根 `vercel.json` 声明 Vite、冻结 lockfile 安装、`@radar/web` 构建、`apps/web/dist` 输出、SPA fallback、安全响应头与缓存；`git.deploymentEnabled=false` 关闭 Git 自动部署，保证 Actions 的质量门禁。

固定版本的根开发依赖 Vercel CLI 依次执行 `vercel pull --yes --environment=production`、`vercel build --prod`、`vercel deploy --prebuilt --prod`。build 步骤显式注入公开 API 地址、Release 版本和 commit SHA，部署上传本次预构建产物。2026-11-03 已创建实际 Vercel 项目并配置三项仓库 Secrets；以后配置缺失时发布按错误停止。具体配置与切换顺序见 [自动发布与服务器更新](23-release-and-update.md)。2026-11-03 用户已完成前端域名映射，Vercel 配置、正式域名 HTTPS/静态资源和匿名 API/CORS 验收通过；实际管理员登录、会话与写请求需使用生产凭据另行验收。API 的 DNS、TLS 和 Nginx 仍由服务器承担。
