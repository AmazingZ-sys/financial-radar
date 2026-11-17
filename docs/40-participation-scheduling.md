# 参与窗口增量调度

日期：2026-11-16。设计依据为用户提供的 `financial-radar-optimization-20261116/金融雷达-参与窗口调度优化设计.md`，基线包含线上 `c4f172a`。本次只实施本地代码和验收，不发布服务器。

## 决策

- PostgreSQL 保存计划、合并刷新请求、未来观察、来源变更游标和每日修复游标。Redis 丢失不影响窗口恢复。
- 指标写入触发器在原事务内记录刷新；来源 enabled/mode 变化触发持久来源刷新。后者按 `(source_id,project_id)` 分批展开，重新选择所有启用来源的最新可用观察，不能筛掉更新的未核验条款。
- 单项目重选使用类型化 evidence_id/available_at；排序保持 observed_at DESC、source_id，并追加 id 解决并列。定时检查只读计划快照；遇到未消费的项目/来源刷新先重选。未来指标的下一可用时刻纳入计划；项目尚不存在的未来观察单独持久化，到时通过原 ingestion 路径恢复。
- 计划与刷新均受项目锁保护。到期领取使用 SKIP LOCKED、revision、claim_token、60 秒租约；执行先取项目锁再锁计划。信号、通知 outbox 和计划推进同事务提交。来源行共享锁保证停用与执行有明确提交顺序。
- 每模式 PostgreSQL advisory lock 保证窗口 tick 跨副本串行；每轮最多 25 个到期项，主处理和修复分别 2 秒预算。事务内每条 SQL 按绝对截止时间递减设置 statement_timeout/lock_timeout，超出预算以普通错误回滚；不使用会终止会话的 transaction_timeout 执行业务预算。失败退避并最终保留 FAILED。批次未开始项按令牌释放。
- 修复每批 50 项，主键 keyset 游标持久化；完成后每日重跑。检测配置版本包含算法版本与阈值，变化时重启修复；执行时对旧版本重选。
- 心跳、来源调度、X 检查、outbox 补投、租约回收和窗口 tick 各自运行、错误隔离并在退出时等待在途任务。

## 模式与兼容

`PARTICIPATION_SCHEDULER_MODE=due` 默认使用到期计划。`shadow` 计算并推进计划，不产生窗口信号；`paused` 停止窗口领取和处理，写入刷新继续保留；`legacy` 使用同一有界到期队列，但每个到期项重新选择该项目原始观察，作为投影读取的排障回退。模式通过 Worker 环境设置，切换前停止旧 Worker 并等待在途任务，保证只有一种写路径。采集不再直接发窗口信号，确定性历史信号仍保留。主预算内先处理到期项（最多 1.5 秒），再处理刷新和未来观察，避免持续刷新挤占到期提醒。

原有 `scanParticipationWindows(at, sourceIds)` 保留为显式诊断/集成入口，使用同一观察选择函数和类型化关联。普通 Worker 不再周期调用全量入口。现有 stableKey 和检测器完全复用；恢复跨过结束时间只发到期信号，firstSeenAt/detectedAt 使用真实处理时刻。fixture 不发送真实通知。

上述 `shadow` 是暂停窗口发信的计划演练，不是旧扫描继续发信的无缝双跑；使用它会暂停窗口提醒。既有原始事实和其他告警路径继续保留。模式切换会触发有界修复，期间提醒可能延后，须观察积压。

## 迁移与验证

只增加结构，不修改旧迁移。旧指标 JSON 保留；合法引用和时间回填到类型化列，无效值隔离为 NULL。新表索引事务内创建；历史表索引独立 CONCURRENTLY，迁移器记录校验和、校验定义/有效性、支持中断重试。兼容旧写入的触发器维护类型化列。

验收包含核验撤销、日期变更、来源回退、未来可用、幂等、租约恢复、旧令牌拒绝、模式隔离、独立心跳与有界规模查询。实际命令和结果追加 `docs/acceptance.md`；生产 CPU、swap、VPN 改善与通知延迟需部署后实测。

调度锁和所有窗口事务复用同一个保留连接，每次事务检查 backend PID；连接断开或重连后停止旧轮次，由租约恢复。窗口事务关闭会终止连接的 transaction_timeout，以逐语句剩余时间和提交前截止检查约束累计预算，保留正常 ROLLBACK 路径及会话锁。仓库 Compose 基线为 PostgreSQL 17，本地 embedded PostgreSQL 验证版本单独记录。主键分页将初始页和续页分成不同 SQL，避免通用执行计划把游标退化为过滤条件。

## 发布与恢复步骤

1. 使用现有发布流程构建匹配版本的 API / Worker；在部署目录备份数据库并确认可恢复。先排空旧 Worker，再执行新增迁移，避免新旧窗口写路径同时工作。
2. 保持两份现有 Compose 文件组合；设置 `PARTICIPATION_SCHEDULER_MODE=due` 并启动新 Worker。自动修复从持久游标按批次建立旧项目计划。新观察持续写刷新请求。新增表与列无需删除或回滚。
3. 查看 `worker.participation` 日志的 `durationMs`、`claimed/processed/refreshed/recovered/stale/failed`、`projectSqlMs`、`dueWaitMs`、`oldestDueAgeMs` 和 `refreshBacklogCapped`。后者最多统计 1001 条，1001 表示至少这么多，不能当作精确总量。正常到期量须低于实测处理能力；积压持续增长时调整容量。
4. 暂停时设置 `paused` 并重启排空；排障读取投影时用 `legacy`。回滚镜像保留新增结构和已产生事实，上一版会恢复其旧扫描，因此须同时复核数据库负载。

失败计划和请求保留错误代码。修复来源或数据后，向该资产重新写入刷新请求即可恢复；不要删除事件或通知去重事实。例如在受控运维 SQL 中指定实际模式和资产：

```sql
INSERT INTO participation_refresh_requests(data_mode,asset_key)
VALUES ('live','实际资产标识')
ON CONFLICT(data_mode,asset_key) DO UPDATE
SET attempts=0,last_error_code=NULL,requested_at=clock_timestamp(),next_attempt_at=clock_timestamp();
```

未来观察连续失败 5 次后保留在 `participation_deferred_observations`，修复后将对应记录的 attempts 重置为 0、next_attempt_at 设置为当前时刻；保留原始证据和 available_at。先确认失败原因，再恢复有限数量。`shadow` 以及迁移回填会延迟窗口提醒，不能把模拟推进视为真实通知。

可重复本地专项命令（显式 fixture，连接独立数据库）：

```bash
DATA_MODE=fixture NODE_ENV=test pnpm exec tsx scripts/participation-migration-integration.ts
pnpm exec tsx scripts/participation-integration.ts
pnpm exec tsx scripts/participation-scale.ts
```

后两项使用当前 DATABASE_URL，须先设置独立 Fixture 数据库与 Redis，不能指向生产。规模脚本只测合成到期查询，不据此声称线上 CPU 降低百分比。
