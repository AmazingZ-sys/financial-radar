# 经济日历实现补充设计

2026-11-02；先设计后实现。本模块补充 PRD 的经济日历要求，不将新闻时间推测为预定发布时间。

## 模型

`economic_calendar` 保存 UUID、来源、externalId唯一、标题、国家、scheduledAt(UTC)、previousValue/expectedValue/actualValue（可空字符串）、importance、confirmed、sourceUrl、sourcePublishedAt（未知为null）、dataMode和记录时间。confirmed仅表示来源确认发布，不由当前时间超过scheduledAt推断。只有已配置授权的来源/管理员可信导入可以写入live记录；初版没有可靠通用官方预期值源，live默认空。

## 接口与呈现

GET /api/v1/calendar，分页country/from/to过滤、auth必需，返回{data,meta}；UI显示“未知”数值与“未确认发布”。POST /api/v1/calendar/import 为管理员可信来源导入，Zod严格验证字段、HTTPS URL、UUID/UTC，Origin+CSRF+审计；禁止在live模式导入Fixture或反向污染。导入行为不代表系统已核实来源，confirmed是管理员对来源的显式确认，应保留审计。

## Fixture

显式fixture模式首次初始化三条合成事件，使用example.invalid URL，无真实发布日期/预期/实际值，说明仅测试提醒与空值处理，禁止据此作宏观判断。离线展示使用固定测试UTC时间，不冒充当日真实日程。

## 迁移和验收

增量0002 migration新建表与时间索引，不改0001 checksum；重复迁移跳过。验证分页、时区显示、未知数值、错误日期范围、写鉴权和模式隔离。API OpenAPI与generated types统一更新。
