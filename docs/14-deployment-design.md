# 14 · 部署与发布设计

设计日期：2026-11-02；Vercel 迁移与宿主端口更新：2026-11-03。确定采用 GHCR、semantic-release、Vercel、Docker Compose 与 nginx-host；部署产物和外部实际发布分别记录。本次迁移只替换前端托管，域名映射由用户在部署验证后完成；Vercel 项目、凭据与真实发布状态另行验收。

## 1. 拓扑和配置

前端静态资源发布 Vercel，浏览器直接请求 `https://api.radar.amazingzsys.site/api/v1`。宿主机 Nginx 终止 API TLS，把 `/api/`、`/health`、`/ready` 转发到 `127.0.0.1:13000`。生产 Docker 映射为 `127.0.0.1:13000:3000`，宿主健康检查使用 `http://127.0.0.1:13000/ready`；API 容器仍监听 3000，容器内健康检查与本地开发端口不变。此分工避免占用服务器已有的 3000 服务。API/Worker 使用同仓库构建但独立镜像，连接内网 PostgreSQL 和 Redis。数据库/Redis 无公网端口；开发 Compose 可仅向 loopback 映射端口。

生产 Compose 包含 api、worker、postgres、redis，所有服务有 restart、healthcheck、日志轮转、持久化卷或无状态约束。依赖 `service_healthy` 仅负责启动顺序，应用仍需运行时重连和退避。Worker 健康检查以更新到 Redis/数据库的心跳为依据，不能仅检查进程存在。

环境分为应用配置 `.env` 与部署配置 `deploy.env`。部署配置包含 GHCR owner/repository、明确版本、Compose 文件、Nginx reload 开关、健康检查 URL、备份目录与域名，不包含前端私密值。生产必须显式 DATA_MODE=live 或 fixture；fixture 页面永久标识，不允许无意混淆。

## 2. CI 与可靠发布依赖

PR 与 main push 运行同一质量链：冻结 lockfile 安装→格式/ESLint/TypeScript→单元测试→临时 PostgreSQL/Redis 集成测试→迁移验证→web/api/worker 构建→必要安全检查→Playwright 冒烟。

main 验证通过后在同一 workflow 中按 `needs` 运行 semantic-release，创建 Tag/Release/Changelog 并把新版本作为 job output；镜像与 Vercel jobs 直接消费 output。前端 job 依赖 `release`、`images`、`image-manifest`，检出 Release 输出的相同 commit。**不依赖 GITHUB_TOKEN 创建的 release/tag 再触发第二个普通 workflow**。未产生新语义版本时跳过发布，但 CI 仍完成。

提交约定：`feat` 生成 minor，`fix` 生成 patch，breaking footer 生成 major。文档/测试等提交不单独触发版本。semantic-release 配置只允许 main 发布，首版不使用 npm publish。Changelog 与 package version 可作为 release 资产或通过受控 bot 提交，避免无穷 CI 循环。

镜像包含 OCI version、revision、source、created 标签。API 与 Worker 同时推送 `vX.Y.Z`、`sha-<commit>`，部署时推荐固定 digest。`latest` 不是生产唯一依据。镜像 push 最小权限 `packages:write`；Release 需要 `contents:write`，其余作业 `contents:read`。

API/Worker 的 ESM 启动 banner 使用独立命名的 `createRequire` 导入，避免与打包依赖的同名导入冲突。构建成功后、容器验收前，对所有服务端产物执行 Node 语法检查；打包成功本身不能证明生成模块可启动。

Vercel CLI 作为根工程精确版本 devDependency 随 pnpm lockfile 安装。根 `vercel.json` 指定 Vite、`pnpm install --frozen-lockfile`、`pnpm --filter @radar/web build` 和 `apps/web/dist`；Vercel 项目 Root Directory 为仓库根目录 `.`，Node.js 为 24.x。设置 `git.deploymentEnabled=false`，由通过质量门禁的 Actions 负责发布。

Actions production 环境使用 `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID` Secrets，依次执行 `vercel pull --yes --environment=production`、`vercel build --prod` 和 `vercel deploy --prebuilt --prod`。构建显式注入公开 `VITE_API_BASE_URL`、Release 版本与 commit SHA，不把服务端密钥传给 Web。预构建产物随同版本发布，部署时不二次重建。没有 GHCR/Vercel 凭据和项目配置时本地只能验证构建与工作流，不能声称已发布。

## 3. 一键更新事务

`deploy.sh --version vX.Y.Z` 的顺序：

1. 校验版本格式、必要配置、Docker/Compose、磁盘空间与 GHCR 访问。
2. 获取指定 Release，校验 API/Worker 镜像标签或 digest 都存在。
3. 使用 flock 或目录锁禁止并发部署，记录当前已验证版本。
4. `docker compose config --quiet`，拉取镜像，不触碰数据卷。
5. `backup.sh` 生成 PostgreSQL 自定义格式备份并检查非空；生产备份失败终止。
6. 独立短时容器执行经审查的非破坏性迁移，数据库迁移锁防止并发。
7. 更新 API/Worker；健康检查包含 API ready、Worker 心跳、数据库与 Redis。
8. `nginx -t` 成功后，在显式配置允许的情况下 `systemctl reload nginx`；不无条件 restart。
9. 持久化本次已验证版本，输出版本/commit/健康结果，释放部署锁。

任一步骤失败返回非零；应用更新后失败可自动切回前一个已验证应用版本并重新检查，但不得撤销数据库。生产脚本不得执行 `down -v`、删除数据卷或强制重建数据库。可选择从 GitHub 获取最新稳定 Release，但解析后必须打印并锁定明确版本。

## 4. 回滚与数据库兼容

`rollback.sh` 默认读取 previous-known-good，允许显式版本，验证镜像与当前 Schema 兼容后更新 API/Worker。迁移使用 expand/contract：先加可空列/新表并兼容旧程序，回填后再在后续版本删除。破坏性迁移不自动执行，需要维护窗口、备份和人工决策。

应用回滚不能被描述为数据库回滚。数据库恢复是独立事故操作：停止写入、验证备份、在新实例恢复并核对，再切换连接。备份脚本保留时间戳、版本及校验和，不把密码放命令行或输出。

## 5. Nginx、Vercel 与运维验收

Nginx 模板设置 Host/X-Forwarded-Proto/X-Request-ID，限制 body，配置 10s connect 与合理 read timeout、安全响应头和访问日志。无实际 WebSocket 时无需伪造 upgrade 支持。模板已填写 API 域名 `api.radar.amazingzsys.site` 和对应证书路径，首次需由操作者安装项目独立站点并申请证书。`deploy.sh` 不安装站点、不申请证书，只在允许时执行语法检查与平滑 reload。已有部署迁移到 13000 时需同步更新宿主 Compose、`deploy.env` 的健康 URL 和本项目 Nginx upstream；保留生产配置、`.deploy`、数据卷及其他网站配置。

根 `vercel.json` 添加 Vue Router history 的 SPA fallback，`/assets/*` 使用内容哈希长缓存，HTML 使用需重新验证的缓存策略，并保留 nosniff、Referrer-Policy 与 CSP。前端自定义域名继续为 `radar.amazingzsys.site`，与 API 使用同注册域；生产 `WEB_ORIGIN`、Secure/HttpOnly/SameSite=Lax Cookie 与 CSRF 校验保持精确配置。临时 `vercel.app` 域名只验静态页面，不自动加入生产允许名单，也不据此声称登录已联通。Vercel 部署和静态验收完成后，用户在项目中配置域名并修改 DNS 映射，再验证 HTTPS 与完整登录读写。

验收需区分：本地单测/构建通过、Compose 集成通过、镜像构建通过、GHCR 发布成功、Vercel 部署成功、域名切换成功、生产服务器健康检查成功。原有 Netlify 发布证据作为历史保留，不能作为 Vercel 已发布的证据。缺少 Docker daemon、服务器、域名或密钥时记录未执行的验收项，保留完整可运行脚本。
