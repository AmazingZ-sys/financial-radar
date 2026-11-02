# 自动发布与服务器更新

配置日期：2026-11-02。仓库为 `AmazingZ-sys/financial-radar`；前端发布目标为 <https://financial-radar-amazingz.netlify.app>。实际版本、镜像摘要和运行结果以 [GitHub Releases](https://github.com/AmazingZ-sys/financial-radar/releases) 与 [Actions](https://github.com/AmazingZ-sys/financial-radar/actions) 为准。

## 开发者发布

向 main 推送 Conventional Commit 后，单一 GitHub Actions 工作流依次执行：完整校验 → semantic-release → API/Worker GHCR 镜像 → Release 镜像清单 → Netlify 生产发布。首次功能提交生成 v1.0.0；以后 feat 增加 minor、fix 增加 patch，纯 docs/chore 提交无版本变化时不重复发布。

仓库已配置加密的 `NETLIFY_AUTH_TOKEN`、`NETLIFY_SITE_ID` Secrets，以及公开的 `VITE_API_BASE_URL` Variable；密钥不保存在工程文件。Netlify CLI 显式选择 `@radar/web`，使用 `--no-build` 上传 CI 已按版本/SHA/API地址构建的产物。域名在 Netlify 站点设置中绑定。

后端域名尚未提供，当前 `VITE_API_BASE_URL=/api/v1` 只是临时同源前缀，前端发布不代表后端已接通。后端部署后，将仓库 Settings → Secrets and variables → Actions → Variables 的该变量设为完整 HTTPS API 前缀，例如 `https://api.example.com/api/v1`。然后在 Actions 的 Verify and release → Run workflow 输入已存在的稳定 Release（如 v1.0.0），会重新验证并部署同一版本。前端与后端建议使用同一注册域；后端 `WEB_ORIGIN` 必须等于实际前端域名。

Netlify 发布失败时可重跑失败的 job，无需再造一个版本。Release 镜像仍在构建时，服务器会保留原版并选择此前已完成镜像发布的稳定版本；没有已完成版本则安全退出。

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
