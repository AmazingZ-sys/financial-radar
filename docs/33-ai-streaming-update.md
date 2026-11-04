# AI 流式接收版本更新

本轮修复 AI 分析持续输出时仍被 60 秒总计时取消的问题。发布版本及镜像以 [GitHub Releases](https://github.com/AmazingZ-sys/financial-radar/releases) 的实际 tag、`release-metadata.json` 与 `image-manifest.json` 为准。

## 生效范围

前端由既有 Vercel 发布工作流更新，后端由管理员更新 API 与 Worker。配置字段不变，保存的模型、推理强度、Key、预算和超时值继续保留；不涉及数据库结构迁移或宿主 Compose/部署脚本变更。

页面中的超时值改为首包/连续无数据等待上限，持续收到字节时会续期；后台分析另设 10 分钟总上限。流式接收和新超时策略需要 API、Worker 更新后才生效，前端先发布时旧 Worker 仍使用原来的总超时策略。Low 连接测试也请求上游流式，但总上限保留 60 秒。

AI 使用独立队列，采集和通知继续使用原队列；旧 Redis 队列中的分析会转交新队列，无需手动清空 Redis。完整输出须通过 JSON 与证据校验后才保存，断流和 token 截断会显示失败。

## 更新后端

等待目标 Release 的 API、Worker 镜像及镜像清单发布完成后执行：

```bash
sudo bash /opt/financial-radar/infra/scripts/deploy.sh --version vX.Y.Z
```

将 `vX.Y.Z` 替换为目标实际 tag。日常镜像更新无需 git pull，不需要重设服务器密钥或删除任何数据卷。部署脚本校验不可变镜像摘要、备份、迁移并检查应用健康。

更新后核对 `/health` 的版本/SHA 与 `/ready`，刷新系统管理页面。已保存的 60000 毫秒表示最多等待 60 秒首包或连续无数据；上游若一直没有字节返回仍会超时，达到现有分析 1000 token 输出上限也会失败，流式不能恢复供应商中断的同一次生成。

部署停止宽限仍沿用原值，在途长流可能被重启中断并在租约恢复后重试；可等当前分析结束后再更新。
