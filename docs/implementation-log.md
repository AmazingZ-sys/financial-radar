# 实施记录

## S0 · 设计门禁（2026-11-02）

已创建 00–18 设计文档及兼容路径；原始需求保存在 user-request.md。官方来源调研先于 Connector 实现。附件末尾截断已记录。后端/API 与前端采用 `{data,meta}` 响应契约。FRED 等授权冲突默认关闭；此阶段Docker daemon尚未运行，先采用本地真实 PG/Redis 验证。S1–S5 的实际验收结果记录如下。

## S1 · 工程与数据

pnpm workspace/Turbo、所有固定技术包、strict TypeScript与统一配置/日志已建立。PostgreSQL 29业务表、Drizzle与两次增量迁移；重复迁移checksum/advisory-lock验证通过。数据关系按06设计合并部分JSONB，未丢弃原始证据。无真实密钥写入仓库。

## S2 · API、采集和引擎

Hono/Zod/OpenAPI、认证/CSRF/限流、47个HTTP操作、规则/评分/项目/回放/通知/AI/审计完成。真实PG/Redis纵向63项与模式隔离76项通过；来源实采Fed20/GitHub30/Treasury63，其他源的真实验证边界见acceptance。AI与IM默认未配置；Fixture模拟记录不外发。

## S3 · 中文控制台

主要页面、详情/筛选、规则读写、通知和源管理、权重版本、人工复核、时区/观察列表、深浅主题与移动布局完成。Chromium 10项真实API E2E全部通过，含失败重试、持久化与390px无横向溢出。截图已实际查看。未授权行情不伪造图表。

## S4 · 部署与发布

Dockerfile/Compose、宿主Nginx、GHCR语义发布/Netlify同workflow needs链、不可变摘要和真实SHA元数据、备份/新库恢复/应用回滚已编写；11项部署脚本故障路径、Compose/Bash/actionlint通过。启动Docker Desktop后，API/Worker镜像实际构建成功，隔离生产Compose四服务healthy；重复迁移/采集幂等、生产Session/CSRF、非root、PG/Redis容器替换持久化、真实备份恢复到新库全部通过。唯一验收项目清理完成，证据见acceptance；外部发布仍未执行。

## S5 · 验证和交接

锁定依赖安装、strict/typecheck、lint、format、81项单测、70项主集成+35项历史PG+86项模式隔离、8项真实故障演练、10项E2E、build、生产依赖审计及真实容器验收通过。新增配置范围、UniSat snapshot时间语义、历史指标差分/窗口时钟信号和原始证据折叠后，README和专项文档提供启动/运维/外部依赖；严重风险/真实参与增长同步项目摘要，未知快照不清除已确认风险。本地预览可用，GHCR/Netlify/目标服务器和未授权数据源不记作已上线。

## S6 · 自动发布与一键更新

按用户追加要求接入 GitHub→Release→GHCR→Netlify 流程。修复 Netlify 二次构建覆盖配置、空 API 前缀与 Monorepo workspace 选择；服务器默认只部署镜像清单齐备的稳定 Release，验证实际 digest/version/commit，并保留备份、失败回滚和Nginx配置检测后reload。新增前端3项与部署脚本10项单测，全量94项通过；随后补充镜像完整前缀校验及测试，全量95项、部署专项22项通过。首次真实云端发布v1.0.0的全部job成功，Netlify HTTP200、GHCR两份digest远程可读、脚本实际匿名下载Release清单通过。证据见acceptance与自动发布文档；后端服务器由用户部署。

## S7 · 实际域名与服务器首装交接

用户明确前端 `radar.amazingzsys.site`、后端 `api.radar.amazingzsys.site`，服务器为Ubuntu 22.04/24.04。生产Web API前缀和CI/Netlify配置同步到API子域；Nginx模板采用实际API域名及证书路径，保留HTTP ACME续期。补充专用首装指南，覆盖DNS分工、Docker apt源、交互式生产配置、HTTP签证书到HTTPS切换、首次部署、检查、更新、备份和回滚。本地95项单测及70+35+86集成检查通过，Nginx在隔离容器中语法验证通过；域名DNS和生产证书/服务器由用户完成，未声称业务登录已联通。

## S8 · 生产宿主端口避让

2026-11-03 用户反馈服务器 3000 已被占用。先更新部署设计，再将生产映射改为 `127.0.0.1:13000:3000`，同步 Nginx upstream、部署健康检查默认值及配置示例。容器内端口和本地开发仍为 3000。专用指南增加已安装环境的迁移步骤，明确需更新宿主 Compose、旧 `deploy.env` 和项目 Nginx 站点；保留生产密钥、部署记录、数据卷与其他站点。服务器操作由用户执行，实际验收证据见 acceptance。
