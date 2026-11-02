# Web 控制台实施与验收

验收日期：2026-11-02（Asia/Shanghai）。范围为本地 Fixture 环境和真实本地 PostgreSQL/Redis/API，不代表生产发布或真实链上机会验证。

## 交付

`apps/web` 为 Vue 3 + TypeScript strict + Vite 前端，包含 Pinia、Vue Router、TanStack Vue Query、Tailwind、Element Plus、ECharts 与 Zod。统一 API Client 使用 Cookie credentials、CSRF、超时、统一错误与共享 Schema。路由包含登录、总览、热点与详情、早期机会与项目详情/指标历史、行情、经济日历、规则 CRUD/测试/触发记录、通知、数据源、系统偏好/审计/观察列表/评分版本配置。

所有业务数据来自 API。Fixture 全局横幅及逐条标记，未知行情不填造，机会与风险独立显示。行情有来源、采样时间、延迟与日度来源日期。AI 人工复核只评审辅助解读，不改变事实核验或评分。通知状态明确“平台已接受”，不宣称已读。

默认本地开发与预览仅绑定 127.0.0.1，VITE_API_BASE_URL 表示完整 API 前缀，默认 `/api/v1`。桌面固定侧栏，390px 移动端抽屉导航，深浅主题，用户时区持久化并用于时间显示。

## 已执行检查

- `pnpm --filter @radar/web typecheck`：通过。
- `pnpm --filter @radar/web build`：通过。Zod 包注释触发 Rollup 的 PURE annotation 提示，构建正常完成。
- `pnpm exec eslint apps/web`：通过，无错误或警告。
- `pnpm exec vitest run apps/web/src/lib/api.test.ts`：6/6 通过，覆盖 CSRF/credentials、坏响应拒绝、请求 ID、网络错误、来源 URL、未知与零值。
- `pnpm exec playwright test`：10/10 通过，最新29.2秒，使用真实 API 和数据库读写。覆盖 Fixture 与来源证据、规则 CRUD/测试/删除持久化、深浅主题与移动导航、通知凭据状态、日历未知/发布确认、时区持久化、评分版本不可覆盖、网络失败→重试恢复、来源停用→刷新持久化→恢复、人工复核不改变评分、展开真实原始payload/评分解释及来源筛选回显。
- Chromium 全页检查：`/markets /rules /notifications /sources /system /calendar` 无 error-state，浏览器 pageErrors 为空。
- 1440px 桌面、390px 移动端实际截图肉眼检查；移动 document.scrollWidth=390，无页面横向溢出。

E2E 在 beforeAll 进行一次真实 UI 登录，内存复用 Cookie 到各独立 context，避免测试登录撞到生产规则的限流。网络故障测试仅 abort 请求，恢复后读取真实 API；不伪造业务成功数据。来源停用测试最终恢复原启用状态；时区恢复 Asia/Shanghai；评分新版本测试恢复原权重数值但保留新版本与历史审计。开发期间曾清除开发 Redis 的单个登录限流 key；未更改生产限流规则。

## 截图

本地可审阅截图位于忽略目录 `.local/`：

- `dashboard-final.png`
- `opportunities-final.png`
- `opportunities-mobile-final.png`
- `project-detail-desktop.png`
- `calendar-desktop.png`

最终截图前确认只有4个预期Fixture项目、5个基线事件、1条基线规则，临时历史测试对象已清理。桌面scrollWidth/viewport均1440，移动均390，pageErrors为空；启用reduced motion并等待布局稳定后截图。截图仅用于本地验收，不作为真实实时金融数据证据。

## 外部边界

Telegram 无真实凭据，发送测试按钮按 configured/enabled 状态禁用；未声称真实消息送达。Netlify 未凭据部署，当前只验证静态构建。需要生产管理员凭据、域名与 HTTPS、同站 Cookie/CORS 和服务器 API 才能生产验收。免费源与授权源延迟由后端标记，前端不会假定实时。
