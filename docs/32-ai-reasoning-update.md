# AI 推理强度版本更新

本次功能：AI 推理强度支持 Low / Medium / High / XHigh，默认 XHigh；连接测试固定使用 Low，实际分析使用保存的强度。Release 版本及镜像以 [GitHub Releases](https://github.com/AmazingZ-sys/financial-radar/releases) 的已完成发布清单为准。

## 前端先发布、后端稍后更新

前端通过既有 Vercel 工作流发布，API 与 Worker 的服务器更新由管理员执行。前端发现旧后端尚无推理强度字段时，会提示升级、禁用推理选择与连接测试；其他 AI 配置仍可保存。服务器升级后刷新页面即启用新功能。

## 更新 API 与 Worker

确认目标 Release 的 API、Worker 镜像与 `image-manifest.json` 均已发布成功，再在服务器运行：

```bash
sudo bash /opt/financial-radar/infra/scripts/deploy.sh --version vX.Y.Z
```

将 `vX.Y.Z` 替换为本次实际 Release tag。部署脚本校验清单和不可变镜像 digest、备份数据库并检查应用健康。本次不涉及数据库结构迁移，也不需要更换服务器的集成加密根密钥、会话密钥、AI Key 或通知凭据；已有配置和规则保留。

`AI_REASONING_EFFORT=xhigh` 是可选服务器初始默认，未设置也默认 XHigh；数据库已保存的选择优先。没有该字段的旧数据库配置会兼容为 XHigh。

更新后检查 `/health` 的版本和 `/ready`，再进入「系统管理 → AI Provider 配置」选择并保存强度。连接测试使用 Low，不会把保存的 XHigh 改成 Low。具体档位是否受模型支持由实际供应商决定，失败时会显示错误，不会静默更换强度。

本次线上添加的「基础监测 · 关键变化（示例）」属于数据库配置，独立于镜像发布；更新代码不会重新创建它。规则仅对后续新事件执行通知，不回推历史事件。
