# Solana 指定 Program 历史补偿

设计日期：2026-11-04。适用 `solana-mints`，仅配置的 Program、finalized 交易内 SPL Token 初始化事件。

## 原因与正确性要求

旧适配器只请求最新 100 条签名，有既存 checkpoint 且响应满 100 条时直接报永久错误。因此任何超过 100 条的积压都无法自行恢复。扩大单次 limit 仍不能解决持续积压与中途失败。

`getSignaturesForAddress` 按新到旧返回，`before` 排除指定签名。补偿先向历史扫描，必须实际看到旧 checkpoint 签名，才开始从旧到新读取交易。空页、历史裁剪、重复/失序页面都不表示历史完整。相关官方契约：[getSignaturesForAddress](https://solana.com/docs/rpc/http/getsignaturesforaddress)。

## 持久进度与有界工作

- 扫描每轮最多一页 100 条，checkpoint 的 `signature/slot` 保持不变；`solanaRecovery` 只保存恢复进度。
- 页描述保存首条签名、数量和 SHA-256 摘要。回放时以 `before: 首条签名` 重读该页余下签名并核对摘要，避免新交易到来挤动页头。最多保存 1,000 页（100,000 条）；超限保留已提交进度，明确要求缩小监控范围或专门历史索引。
- 找到旧 checkpoint 后，按最旧页至最新页、页内旧至新回放。每轮最多读取 20 笔交易，剩余签名与页锚点随 worker 的 PostgreSQL checkpoint 事务持久化；重启后恢复。
- 只有该轮交易均成功读取并且原始事件成功入库后，canonical `signature/slot` 才前进到本轮已处理的最后一条。交易 RPC 返回 null、版本不支持、页摘要变化或任意错误时整轮不提交。
- 初次配置仍只取最新 100 条作为有界启动窗口，明确 `bootstrapHistoryLimited: true`，分轮读取，不声称补齐此前历史。
- 扫描中遇到 provider 空页且尚未见旧 checkpoint，报历史覆盖缺口，不删除 checkpoint、不切换 Fixture。使用保留该时间段历史的 RPC 后可从同一持久进度继续。

## 数据源健康状态

扫描或回放尚未结束时，worker 将健康状态保留为 `degraded`，提示“Solana 历史补偿中”，不更新 `last_success_at`。恢复进度可单独持久化；只有所有已知页面回放完成后，才回到 `healthy`。

## 吞吐边界与验证

本次生产 UI 观察到配置的 Program 为 `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`（Pump.fun），高流量是当前实际约束。每轮 20 笔、默认 60 秒轮询不足以承诺持续追上该 Program。该功能用于有界 watch 范围；持续积压需缩小 Program 范围、经授权的历史索引/流订阅方案或另行设计有预算的 catch-up 调度。

单测覆盖超过 100 条、跨轮恢复、新到交易、回放异常重试、历史缺口、重复页与初始窗口；真实 PostgreSQL 集成使用明确标记的 Fixture RPC，验证扫描期 canonical 不动、失败事务不前进、重建 connector 后继续、最终完整与幂等。真实 RPC 历史覆盖与生产部署另行验收。
