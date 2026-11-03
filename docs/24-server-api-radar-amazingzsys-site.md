# api.radar.amazingzsys.site 后端部署步骤

更新日期：2026-11-03。以下步骤由你在服务器执行；我们尚未登录或部署这台服务器。主流程适用于 Ubuntu 24.04 / 22.04 LTS、systemd、Linux amd64 服务器，建议至少 2 vCPU、4 GB 内存和 30 GB 可用磁盘。已有可工作的 Docker/Nginx 可继续复用；已按旧指南部署到宿主 3000 的情况见第 9 节。当前发布镜像为 linux/amd64，ARM64 服务器不能直接按本指南运行。

## 1. 确认地址和网络

| 用途              | 地址或配置                                              |
| ----------------- | ------------------------------------------------------- |
| 浏览器前端        | `https://radar.amazingzsys.site`                        |
| 服务器 API        | `https://api.radar.amazingzsys.site`                    |
| 前端请求          | 直接请求 `https://api.radar.amazingzsys.site/api/v1/*`  |
| 后端 `WEB_ORIGIN` | `https://radar.amazingzsys.site`                        |
| Cookie            | `SECURE_COOKIE=true`、`COOKIE_SAME_SITE=Lax`            |
| API 端口映射      | 宿主 `127.0.0.1:13000` → 容器 `3000`，仅宿主 Nginx 访问 |

域名分工：`radar.amazingzsys.site` 是 Netlify 前端，Netlify站点已配置该自定义域名；请检查DNS是否也按 Netlify 域名管理页面给出的记录绑定（子域通常为指向 `financial-radar-amazingz.netlify.app` 的 CNAME），不应继续指向后端服务器。`api.radar.amazingzsys.site` 才是服务器 API，在 DNS 服务商新增该子域的 A 记录，指向你确认的服务器公网 IPv4。仅在服务器 IPv6、80/443 路由与 Nginx 都已配置时添加 AAAA；错误 AAAA 会导致浏览器或证书验证访问错误地址。首次申请证书时让该域名直接解析到服务器，不要先使用另一个来源站的代理或跳转。

2026-11-02 首次只读检查时，前端 `radar.amazingzsys.site` 和后端 `api.radar.amazingzsys.site` 的 A 记录都指向 `49.51.38.38`，未得到 AAAA 记录；当时 API 的 HTTPS `/health` 证书与主机名不匹配，curl 返回60。同日稍后已验证前端域名由 Netlify 通过 HTTPS 返回200，且 v1.0.2 线上产物使用正确 API 地址。以上均为当日历史观察，不代表当前 DNS、证书或后端部署状态。部署前请重新核对 API 解析确为你的服务器公网IP，并按第5步配置 API 证书；不能通过 `curl -k` 或关闭前端TLS校验绕过证书错误。

云安全组及宿主防火墙放行 TCP 80、443；SSH 端口只对你的管理 IP 放行。本项目无需对公网开放 13000、5432、6379。若已有防火墙，先确认当前 SSH 连接和规则，再调整；本指南不直接启用或清空防火墙。

登录服务器后检查：

```bash
uname -m
cat /etc/os-release
sudo ss -ltnp 'sport = :13000'
```

`uname -m` 应为 `x86_64`。`ss` 除表头外应没有监听记录；若 13000 已被占用，先查明占用并停止此次部署。生产仅使用宿主 13000，不占用服务器现有的 3000 服务；容器内部 `PORT=3000` 不需要修改。下文使用 `/opt/financial-radar`，不会在服务器安装 Node.js 或 pnpm，应用运行于已构建的 Docker 镜像中。

## 2. 安装 Docker、Nginx 和工具

若服务器已安装可工作的 Docker Engine / Compose v2，请保留现有安装，直接核对版本；以下 Docker 仓库命令用于新 Ubuntu 服务器。若已有 Docker 冲突包或自定义存储，先按 [Docker 官方 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/)处理，避免直接替换运行中的服务。

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq openssl python3 nginx certbot dnsutils
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker nginx
sudo docker version
sudo docker compose version
```

使用 Debian 12/13 时，基础工具的 apt 包名相同，但 Docker 仓库必须采用 [Docker 官方 Debian 安装说明](https://docs.docker.com/engine/install/debian/)：以上下载 GPG 和 `URIs` 的路径改为 `linux/debian`，`Suites` 使用该 Debian 的 `VERSION_CODENAME`，不要混入 Ubuntu 仓库。若已装 Docker，无需重复添加仓库。

确认解析结果已是服务器地址：

```bash
dig +short A api.radar.amazingzsys.site
dig +short AAAA api.radar.amazingzsys.site
```

## 3. 拉取部署文件

```bash
sudo git clone https://github.com/AmazingZ-sys/financial-radar.git /opt/financial-radar
cd /opt/financial-radar
sudo git fetch --tags origin
sudo git status --short
```

若目录已经存在，先检查其内容与 Git 状态，保留已有 `.env`、`deploy.env`、`.deploy` 和数据，跳过 clone；不要删除目录后重做。当前镜像可匿名拉取，无需 GHCR 登录。后续若镜像改为私有，再配置只读镜像凭据。

## 4. 生成生产 `.env`

以下代码只在 `.env` 不存在时创建它。它从模板保留全部可选配置，生成独立随机 PostgreSQL / Redis 密码和 Session Secret，自动建立匹配且已编码的容器连接串。管理员邮箱、密码从 SSH 终端输入，密码不回显，也不写入 Shell 历史。

```bash
cd /opt/financial-radar
sudo python3 - <<'PY'
from pathlib import Path
from urllib.parse import quote
import getpass
import os
import re
import secrets

root = Path('/opt/financial-radar')
path = root / '.env'
if path.exists():
    raise SystemExit('.env 已存在，保留原文件。请用 sudoedit /opt/financial-radar/.env 检查。')

values = {}
for line in (root / '.env.example').read_text().splitlines():
    if line and not line.lstrip().startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        values[key] = value

with open('/dev/tty', 'r+') as tty:
    tty.write('管理员邮箱：')
    tty.flush()
    email = tty.readline().strip()
    if len(email) > 200 or not email.isascii() or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
        raise SystemExit('邮箱格式不正确，尚未创建 .env。')
    password = getpass.getpass('管理员密码（16至200位）：', stream=tty)
    repeated = getpass.getpass('再次输入管理员密码：', stream=tty)
password_length = len(password.encode('utf-16-le')) // 2
if password != repeated or not 16 <= password_length <= 200 or password == 'change-me-local-only':
    raise SystemExit('密码不一致、长度超出16至200位或仍为开发默认密码，尚未创建 .env。')
if any(c in email + password for c in "'\r\n"):
    raise SystemExit('邮箱和密码不能含单引号或换行，尚未创建 .env。')

pg_password = secrets.token_hex(32)
redis_password = secrets.token_hex(32)
values.update({
    'NODE_ENV': 'production',
    'PORT': '3000',
    'WEB_ORIGIN': 'https://radar.amazingzsys.site',
    'DATA_MODE': 'live',
    'DATABASE_URL': f'postgresql://radar:{quote(pg_password, safe="")}@postgres:5432/radar',
    'REDIS_URL': f'redis://:{quote(redis_password, safe="")}@redis:6379',
    'ADMIN_EMAIL': email,
    'ADMIN_PASSWORD': password,
    'SESSION_SECRET': secrets.token_hex(48),
    'SECURE_COOKIE': 'true',
    'COOKIE_SAME_SITE': 'Lax',
    'POSTGRES_DB': 'radar',
    'POSTGRES_USER': 'radar',
    'POSTGRES_PASSWORD': pg_password,
    'REDIS_PASSWORD': redis_password,
    'IMAGE_REPOSITORY': 'ghcr.io/amazingz-sys/financial-radar',
    'APP_VERSION': 'v1.0.2',
    'COMMIT_SHA': 'bootstrap',
    'LOG_LEVEL': 'info',
})
if any("'" in value or '\n' in value or '\r' in value for value in values.values()):
    raise SystemExit('配置值含不支持的引号或换行，尚未创建 .env。')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as file:
    file.write('\n'.join(f"{key}='{value}'" for key, value in values.items()) + '\n')
print('生产 .env 已创建，权限 0600；密码和密钥未输出。')
PY
```

`APP_VERSION=v1.0.2` 仅供未部署时的 Compose 配置检查使用，部署脚本会从最新已完成的 Release 自动选择版本、commit 和镜像摘要。不要在 `.env` 手工填 `API_IMAGE` 或 `WORKER_IMAGE`。

可选真实来源与通知/AI 配置用以下命令修改，密钥只留在服务器：

```bash
sudoedit /opt/financial-radar/.env
```

首装可保留 Telegram、LLM、UniSat、EVM、Solana、DEX 地址为空。`DATA_MODE=live` 不使用 Fixture 回填；无需凭据的已实现来源会尝试采集，未配置来源显示未配置，网络不可用时显示错误/过期。部分页面为空是正常情况，不能以“有页面数据”为由将生产切成 Fixture。所有当前覆盖范围见数据源文档。

创建部署脚本配置，已存在则保留：

```bash
cd /opt/financial-radar
sudo python3 - <<'PY'
from pathlib import Path
import os
root = Path('/opt/financial-radar')
path = root / 'deploy.env'
if path.exists():
    raise SystemExit('deploy.env 已存在，保留原文件。')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as file:
    file.write((root / 'infra/scripts/deploy.example.env').read_text())
print('deploy.env 已创建，保留 NGINX_RELOAD=true。')
PY
sudo install -m 0700 -d /var/backups/financial-radar
sudo docker compose --env-file .env config --quiet
```

不要把完整的 `docker compose config` 或 `.env` 发到聊天或日志；`--quiet` 只验证，不输出展开后的密码。

## 5. 先配置 HTTP，再申请 HTTPS 证书

`deploy.sh` 不会自动安装或修改 Nginx 站点，也不会首次申请证书；它仅在应用健康且 `NGINX_RELOAD=true` 时检查配置并平滑 reload。已有 Nginx 可以直接复用，本节只添加本项目的独立站点。先不要直接安装仓库里的完整 HTTPS 配置，因为首次申请前证书文件还不存在。创建 ACME webroot：

```bash
sudo install -m 0755 -d /var/www/letsencrypt/.well-known/acme-challenge
```

下面的文件名专用于本项目。若 `/etc/nginx/sites-available/financial-radar` 或同名 sites-enabled 已存在，请先检查原配置并保留备份，跳过首次写入；不要覆盖其他站点。

```bash
sudo python3 - <<'PY'
from pathlib import Path
path = Path('/etc/nginx/sites-available/financial-radar')
config = '''server {
    listen 80;
    server_name api.radar.amazingzsys.site;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
        try_files $uri =404;
    }
    location / {
        return 404;
    }
}
'''
with path.open('x') as file:
    file.write(config)
PY
sudo ln -s /etc/nginx/sites-available/financial-radar /etc/nginx/sites-enabled/financial-radar
sudo nginx -t
sudo systemctl reload nginx
```

80 端口此时除 ACME 路径外返回 404，是预期行为。若 `nginx -t` 报同域名冲突，先查明哪个现有站点占用该 server_name。不要删除其他默认或业务站点来绕过错误。

输入用于证书到期通知的邮箱并申请证书：

```bash
read -r -p '证书通知邮箱：' radar_certificate_email
sudo certbot certonly --webroot --webroot-path /var/www/letsencrypt \
  --domain api.radar.amazingzsys.site \
  --email "$radar_certificate_email" --agree-tos --non-interactive
```

此步骤要求公网 80 能访问该服务器，DNS A/AAAA 均正确。证书签发后，再将仓库已填入实际域名的模板安装到此站点：

```bash
cd /opt/financial-radar
sudo cp /etc/nginx/sites-available/financial-radar /etc/nginx/sites-available/financial-radar.http-bootstrap
sudo install -m 0644 infra/nginx/financial-radar.conf /etc/nginx/sites-available/financial-radar
sudo nginx -t
sudo systemctl reload nginx
```

后端未启动前 HTTPS 可能返回 502；证书正确且 Nginx 配置通过即可继续。最终配置保留 80 端口的 ACME webroot，其余 HTTP 请求跳转 HTTPS，以供续期验证。该流程采用 [Certbot 官方 webroot 方式](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)，无需停止 Nginx。

配置证书更新后检测并重载 Nginx：

```bash
sudo install -m 0755 -d /etc/letsencrypt/renewal-hooks/deploy
sudo install -m 0755 /dev/stdin /etc/letsencrypt/renewal-hooks/deploy/financial-radar-nginx <<'SH'
#!/usr/bin/env bash
set -euo pipefail
nginx -t
systemctl reload nginx
SH
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
sudo systemctl list-timers certbot.timer --no-pager
```

Certbot 的定期任务与 dry-run 说明见 [官方续期文档](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates)。dry-run 成功表示续期验证可完成，实际证书更新时 deploy hook 才执行。

## 6. 一条命令首次部署

```bash
sudo bash /opt/financial-radar/infra/scripts/deploy.sh
```

脚本自动选择镜像发布已完成的最新稳定 Release，下载并校验版本、commit 和 API/Worker 不可变摘要；拉镜像后验证实际标签，启动 PostgreSQL/Redis，先备份再迁移，再启动 API/Worker。两个应用健康后才 `nginx -t` 并平滑 reload。数据库与 Redis 没有公网端口。

成功输出以 `Deployed and verified v...` 开头。首次迁移、拉镜像和启动可能持续几分钟；不要同时再运行第二个部署进程。脚本锁在 `.deploy/lock`，只有确认没有部署进程后才能处理残留锁。

## 7. 检查与登录

```bash
sudo bash /opt/financial-radar/infra/scripts/check-health.sh
curl --fail --silent --show-error https://api.radar.amazingzsys.site/health | jq
curl --fail --silent --show-error https://api.radar.amazingzsys.site/ready | jq
curl --silent --show-error --include https://api.radar.amazingzsys.site/api/v1/auth/me
```

前两条公网健康请求应为 HTTP 200。最后一条在未登录时应返回 HTTP 401 及 JSON错误，这是 API 认证已到达后端的预期现象。若返回 HTML、404 或502，则检查 API域名的DNS/Nginx和后端健康，不能视作已登录。

检查浏览器跨Origin登录所需的CORS预检：

```bash
curl --silent --show-error --include --request OPTIONS \
  https://api.radar.amazingzsys.site/api/v1/auth/login \
  --header 'Origin: https://radar.amazingzsys.site' \
  --header 'Access-Control-Request-Method: POST' \
  --header 'Access-Control-Request-Headers: content-type'
```

应返回允许预检的成功状态，并包含 `Access-Control-Allow-Origin: https://radar.amazingzsys.site` 和 `Access-Control-Allow-Credentials: true`。若Origin不匹配，检查 `.env` 的 `WEB_ORIGIN` 并重建应用；不要把允许源改为 `*`。

确认 Netlify 控制台已添加 `radar.amazingzsys.site` 自定义域、DNS记录按要求配置并已签发前端HTTPS证书，再打开 [前端登录页](https://radar.amazingzsys.site/login)，使用你在第4步设置的生产管理员邮箱和密码。开发默认账号不会用于本次生产初始化。浏览器网络面板中登录/会话请求应发送到 `https://api.radar.amazingzsys.site/api/v1`，成功后 Cookie 具有 Secure / HttpOnly / SameSite=Lax。后端 `WEB_ORIGIN` 是 `https://radar.amazingzsys.site`，不能设置成 API 自己的 Origin。前后端是不同 Origin、同一注册域，API允许该精确前端Origin并支持凭据Cookie；无需改为SameSite=None。临时的 netlify.app 地址与此配置的Origin不同，不作为生产登录入口。

如果以后把前端绑定到另一个域名，更新服务器 `.env` 的 `WEB_ORIGIN` 为该实际 HTTPS 前端 Origin，再运行部署命令重建应用容器；前端的 `VITE_API_BASE_URL` 继续指向 API 域名。不要改成逗号分隔多个Origin，当前配置只接受一个精确Origin。

## 8. 后续更新、日志和恢复

正常发布后的日常更新：

```bash
sudo bash /opt/financial-radar/infra/scripts/deploy.sh
```

它会跳过仍在构建镜像的 Release。应用健康或 Nginx 校验失败时，脚本尝试回到上一已验证应用，数据库不自动回退。

查看部署版本、健康和最近日志：

```bash
sudo cat /opt/financial-radar/.deploy/current
sudo bash /opt/financial-radar/infra/scripts/check-health.sh
cd /opt/financial-radar
sudo docker compose --env-file .env logs --tail 100 api worker
sudo tail -n 100 /var/log/nginx/financial-radar.error.log
```

直接 `docker compose logs` 只读日志；不要用普通 `docker compose up` 更新应用，因为它不会自动加载 `.deploy` 保存的不可变摘要。日志分享前应检查并脱敏配置与外部服务返回内容。

备份和应用回滚：

```bash
sudo bash /opt/financial-radar/infra/scripts/backup.sh
sudo bash /opt/financial-radar/infra/scripts/rollback.sh
```

备份位于 `/var/backups/financial-radar`，需另行加密复制到异地。回滚只适用于已有上一已验证版本的部署，不恢复数据库；新库恢复操作见 [完整部署手册](20-deployment-runbook.md)。保留生产 `.env`、`deploy.env`、`.deploy` 和卷，不执行 `docker compose down --volumes`。

本次 Nginx 模板与生产 Compose 使用宿主 13000。服务器必须使用包含该变更的仓库版本。以后发行说明若更改宿主 Compose/脚本，再按完整手册先检出同一目标 Release tag，保留本地生产配置后部署；单纯应用镜像更新无需 git pull。

## 9. 已有部署从宿主 3000 迁移到 13000

若还未部署本项目，按前面的新配置首装即可。若已按旧指南配置或启动过，本节同步更新宿主文件和端口；不重新生成 `.env` 或数据库密码，不删除 `.deploy`、数据库、Redis 卷，也不修改占用 3000 的其他服务。

先等待 v1.0.3 的 Release 镜像与清单发布完成，确认新端口空闲并检查现有仓库状态：

```bash
sudo ss -ltnp 'sport = :13000'
cd /opt/financial-radar
sudo git status --short
sudo git fetch --tags origin
sudo git switch --detach v1.0.3
```

`ss` 有监听记录时停止后续操作。Git 因本地修改拒绝切换时，先检查并保留修改，不能使用 `reset --hard` 或删除目录重装。Git 切换会更新受版本管理的 Compose、脚本与模板；被忽略的 `.env`、`deploy.env`、`.deploy` 和 Docker 卷保留。

旧 `deploy.env` 会覆盖脚本的新默认值，因此需要编辑该文件中的健康地址：

```bash
sudoedit /opt/financial-radar/deploy.env
```

保留其他设置，将对应行改为：

```dotenv
HEALTH_URL=http://127.0.0.1:13000/ready
NGINX_RELOAD=true
```

已安装的 Nginx 站点也不会随 Git 更新。以下路径适用于按本指南安装的项目站点；如果你使用了自定义配置路径，请操作 `api.radar.amazingzsys.site` 所在的实际站点文件。先备份并只编辑本项目的 upstream，保留证书与其他定制配置：

```bash
sudo cp --no-clobber /etc/nginx/sites-available/financial-radar /etc/nginx/sites-available/financial-radar.before-13000
sudoedit /etc/nginx/sites-available/financial-radar
```

将本项目的 `proxy_pass http://127.0.0.1:3000;` 改为：

```nginx
proxy_pass http://127.0.0.1:13000;
```

若还未安装本项目 Nginx 站点或签发 API 证书，先完成第 5 节。其他网站配置不做修改。先检查新配置，暂不手工 reload；部署脚本会在 13000 上的应用健康后重载 Nginx：

```bash
sudo nginx -t
sudo bash /opt/financial-radar/infra/scripts/deploy.sh --version v1.0.3
sudo bash /opt/financial-radar/infra/scripts/check-health.sh
curl --fail --silent --show-error http://127.0.0.1:13000/ready | jq
curl --fail --silent --show-error https://api.radar.amazingzsys.site/ready | jq
```

只有 `nginx -t` 成功才继续部署。容器重建期间 API 可能短暂不可用；证书域名没有变化，无需仅因端口调整重新签发。部署成功后，日常仍运行不带版本参数的 `deploy.sh`，它会选择已完整发布的最新稳定版本。
