# 自动发布与服务器更新

配置更新：2026-11-03。仓库为 `AmazingZ-sys/financial-radar`；前端已发布至 Vercel，正式域名继续使用 <https://radar.amazingzsys.site>；API 为 <https://api.radar.amazingzsys.site>。实际版本、镜像摘要和运行结果以 [GitHub Releases](https://github.com/AmazingZ-sys/financial-radar/releases) 与 [Actions](https://github.com/AmazingZ-sys/financial-radar/actions) 为准。Vercel 项目、Secrets 与 v1.1.1 实际部署已完成，生产 [Actions run 41586393459](https://github.com/AmazingZ-sys/financial-radar/actions/runs/41586393459) 全部成功；DNS 已由用户切换，正式域名 HTTPS 与 Vercel 静态资源验收通过。

## 原托管平台的历史发布

[自动发布 run 41405313336](https://github.com/AmazingZ-sys/financial-radar/actions/runs/41405313336) 已全部成功，生成 [v1.0.0](https://github.com/AmazingZ-sys/financial-radar/releases/tag/v1.0.0)，API/Worker镜像、Release清单与Netlify生产站点均实际验证。原站点为 <https://financial-radar-amazingz.netlify.app>。这是迁移前的历史证据，不表示 Vercel 已部署；后续版本以仓库 Releases 与实际 Actions 记录为准。前端公开页面由应用自己的管理员认证保护业务数据。

## 开发者发布

向 main 推送 Conventional Commit 后，单一 GitHub Actions 工作流依次执行：完整校验 → semantic-release → API/Worker GHCR 镜像 → Release 镜像清单 → Vercel 生产发布。前端 job 依赖 `release`、`images` 和 `image-manifest`，检出与镜像相同的 Release commit。首次功能提交生成 v1.0.0；以后 feat 增加 minor、fix 增加 patch，纯 docs/chore 提交无版本变化时不重复发布。

根工程锁定 Vercel CLI 版本，Actions 在 production Environment 中使用 `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID` Secrets。公开 Variable `VITE_API_BASE_URL` 使用 `https://api.radar.amazingzsys.site/api/v1`；build 步骤同时注入 `VITE_APP_VERSION` 和 `VITE_COMMIT_SHA`。密钥不保存在工程文件，也不传入前端构建变量。

发布步骤依次为 `pnpm exec vercel pull --yes --environment=production`、`pnpm exec vercel build --prod`、`pnpm exec vercel deploy --prebuilt --prod`，各步骤使用相同项目和授权；deploy 上传本次预构建产物，不再次构建。根 `vercel.json` 负责 Vite 构建、SPA fallback、安全响应头与静态缓存，并设置 `git.deploymentEnabled=false`，避免 Git 自动部署绕过 Actions。

Vercel 发布失败时可重跑失败的 job，无需再造一个版本。Release 镜像仍在构建时，服务器会保留原版并选择此前已完成镜像发布的稳定版本；没有已完成版本则安全退出。workflow_dispatch 的部署 checkout 使用输入 tag 的文件；迁移前的历史 tag 缺少 Vercel 配置与 CLI，不能直接用于本次 Vercel 发布。首个 Vercel 发布必须包含本次迁移提交。

## Vercel 项目配置与最终域名切换

1. 在实际 Vercel 账户/团队创建或选择本项目，Root Directory 设为仓库根目录 `.`，Node.js 设为 24.x；使用根 `vercel.json` 的 Vite、`pnpm install --frozen-lockfile`、`pnpm --filter @radar/web build` 与 `apps/web/dist` 配置。关闭 Git 自动部署，由 Actions 发布。
2. 将实际项目的组织/团队 ID、Project ID 和有权发布该项目的 Token，分别写入 GitHub production Environment 或仓库的 `VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`、`VERCEL_TOKEN` Secrets。保留公开 `VITE_API_BASE_URL` Variable；不要将后端数据库、Session、AI 或通知密钥配置到 Web 构建环境。2026-11-03 已实际创建 `Amazing's projects / financial-radar` 项目并配置这三项仓库 Secrets；项目使用 Node 24.x。专用 Token 经用户授权，限定当前团队，有效期至 2027-11-03，到期前需轮换。
3. 在包含迁移配置的新 Release 中等待 verify、镜像、清单和 vercel job 成功；检查真实部署 URL 的 `/login`、深层路由、资源加载、安全头、缓存及静态产物 API 地址，并核对部署收据的版本/SHA。v1.1.1 已发布至 [financial-radar.vercel.app](https://financial-radar.vercel.app)，上述静态 HTTP 验收已通过；部署收据与 Vercel READY 状态均对应 `918f038b30e70a058864bf4600f301bf4828f41d`。临时 `vercel.app` 与生产 Origin 不同，此阶段只验静态部署。
4. 已在 Vercel 项目将 `radar.amazingzsys.site` 绑定到 Production。2026-11-03 用户完成 DNS 切换，权威服务器 `heron.dnspod.net` 返回 `radar` 的 CNAME → `6ad0a87c00f0d82f.vercel-dns-017.com`；[Vercel Domains](https://vercel.com/amazings-projects-6f99eda0/financial-radar/settings/domains) 显示 Valid Configuration。正式域名 HTTPS、入口/深层路由/JS/favicon 返回 200，响应实际由 Vercel 提供。API 域名不变，`/health` 与 `/ready` 返回 200，匿名 `/auth/me` 按预期返回 401，凭据 CORS 允许精确正式 Origin。管理员实际登录、写请求与退出需使用用户的生产凭据另行验收，本次未执行。

前端正式域名仍为 `https://radar.amazingzsys.site`；后端服务器仍为 `https://api.radar.amazingzsys.site`。前端直接请求 API，服务器保持 `WEB_ORIGIN=https://radar.amazingzsys.site`、`SECURE_COOKIE=true`、`COOKIE_SAME_SITE=Lax`。两者是同一注册域下的不同 Origin，不需要 Vercel API 代理；临时预览域名不加入生产 CORS/Origin 允许名单，不修改 CSRF/Cookie 策略。前端发布不代表后端已部署；完整首装步骤见 [api.radar.amazingzsys.site 后端部署](24-server-api-radar-amazingzsys-site.md)。

## 服务器首次准备

服务器安装 Docker Engine、Compose v2、Bash、curl、jq、Nginx，准备域名和 HTTPS。当前工作流构建 Linux amd64 镜像。

```bash
git clone https://github.com/AmazingZ-sys/financial-radar.git /opt/financial-radar
cd /opt/financial-radar
cp .env.example .env
cp infra/scripts/deploy.example.env deploy.env
chmod 600 .env deploy.env
```

按 [部署手册](20-deployment-runbook.md) 填写生产密码、Session Secret、PostgreSQL/Redis 编码连接串、Live数据源配置、前端 Origin，并安装 `infra/nginx/financial-radar.conf` 的适配配置。不能原样使用开发密码或本地连接串。若 GHCR 包为私有，先用具备 read:packages 的凭据执行 `docker login ghcr.io`，或在受信任的 deploy.env 配置 GHCR_USER/GHCR_TOKEN。

## 日常一条命令

```bash
sudo bash /opt/financial-radar/infra/scripts/deploy.sh
```

默认查找最新已完成的稳定 Release，验证发布清单并按不可变 digest 拉镜像，备份数据库、迁移、更新 API/Worker、检查健康，最后 `nginx -t` 通过后平滑 reload。数据库卷保留；失败尝试恢复此前已验证应用，数据库迁移不自动逆转。更新不依赖不受控的 latest 镜像标签。

日常镜像更新无需 git pull。若发行说明要求更新宿主 Compose 或脚本，需先按部署手册检出对应 Release tag，再运行脚本；生产 `.env`、deploy.env 和 `.deploy` 状态应保留。脚本不会自动申请证书或修改宿主机配置。
