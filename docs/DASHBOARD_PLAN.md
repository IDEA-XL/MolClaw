# BioClaw Dashboard 实施计划（MVP）

## 1. 目标
- 增加一个轻量 Dashboard，用于实时观测 Agent 执行过程。
- 支持查看：
- Agent 中间过程（provider/tool 调用、阶段、耗时、错误）。
- Agent context 使用情况（history 长度、裁剪情况）。
- 在不引入 Next.js 的前提下，复用现有 Node 进程与 SQLite。

## 2. 范围与边界
- 技术方案：`Express + SSE + SQLite + 单页 HTML`。
- 不做：
- Pixel Office、动画可视化、复杂主题系统。
- 不新增独立前端工程（先保持单仓库、低复杂度）。

## 3. 分阶段实施

## Phase 1：数据模型与埋点（优先）
- 新增 SQLite 表：`agent_events`
  - 字段建议：
  - `id INTEGER PRIMARY KEY AUTOINCREMENT`
  - `ts TEXT NOT NULL`
  - `chat_jid TEXT`
  - `group_folder TEXT`
  - `session_id TEXT`
  - `event_type TEXT NOT NULL`（如 `provider` / `tool` / `lifecycle` / `message`）
  - `stage TEXT`（`start` / `end` / `info` / `error`）
  - `payload_json TEXT`（结构化扩展字段）
- 埋点来源：
  - 现有 `progress` 事件链路（已具备）。
  - 补充 context 指标：
  - `history_message_count`
  - `history_char_count`
  - `trimmed_message_count`
  - `trimmed_char_count`

## Phase 2：落库与事件总线
- 在 `src/index.ts` 和 `src/task-scheduler.ts` 收到 `progress` 时：
  - 写 `agent_events`。
  - 推送到进程内 EventBus（供 SSE 广播）。
- 给 queue 增加只读快照能力：
  - `activeCount`
  - `waitingGroups`
  - per-group `active/pending/retry`

## Phase 3：Dashboard HTTP 服务
- 新增 `src/dashboard.ts`（由主进程启动）。
- 配置项：
  - `DASHBOARD_ENABLED=true|false`
  - `DASHBOARD_HOST=127.0.0.1`
  - `DASHBOARD_PORT=8787`
  - 可选：`DASHBOARD_TOKEN`
- API 草案：
  - `GET /api/health`
  - `GET /api/groups`
  - `GET /api/events?chat_jid=&limit=`
  - `GET /api/context/latest?chat_jid=`
  - `GET /api/queue`
  - `GET /api/events/stream`（SSE，支持按 `chat_jid` 过滤）

## Phase 4：实用型前端页面
- 单页 HTML（无需框架）：
  - 左栏：Group 列表
  - 中栏：事件时间线（tool/provider/lifecycle）
  - 右栏：Context 指标（history 长度、裁剪统计）
  - 顶栏：系统状态（容器并发、等待队列、最近错误）
- 刷新策略：
  - 首屏 HTTP 拉取
  - 后续 SSE 增量更新

## Phase 5：验收与稳定性
- 功能验收：
  - 能实时看到 tool/provider 调用和耗时。
  - 能看到当前会话 history 长度变化。
  - 多群并发下界面数据不串群。
- 稳定性：
  - 大量事件下 SSE 不阻塞主逻辑。
  - 事件保留策略（如仅保留最近 7 天，或按条数裁剪）。
- 安全：
  - 默认仅监听 `127.0.0.1`。
  - 若开公网需启用 `DASHBOARD_TOKEN` 或反向代理鉴权。

## 4. 与 OpenClaw-bot-review 的借鉴策略
- 借鉴：
  - 信息架构（状态概览 + 列表 + 详情）
  - API 分层组织方式
- 不借鉴：
  - Pixel Office、重 UI 动画、与当前需求无关的页面模块

## 5. 预计工作量（MVP）
- Phase 1-2：1 ~ 1.5 天
- Phase 3：0.5 ~ 1 天
- Phase 4：0.5 ~ 1 天
- Phase 5：0.5 天
- 合计：约 2.5 ~ 4 天（取决于联调与边界处理）

## 6. 交付标准（MVP Done Definition）
- `npm run build`、关键测试通过。
- 启动后可访问 Dashboard 页面并实时看到事件流。
- 可按群筛选事件，并查看最新 context 使用指标。
- 出现 tool/provider 错误时，在页面和日志均可定位到同一条事件。

## 7. Phase 4 当前进度（2026-03-14）
- 已完成：
- Dashboard 三栏结构（groups/events/context）和 SSE 实时增量。
- 事件筛选（文本/type/stage）与错误/慢调用高亮。
- Context 指标面板 + sparkline（history chars vs trimmed chars）。
- 顶栏实时指标：工具调用数、错误数、最新 history 使用情况。
- 群列表联动队列状态（active/pending/retry）。
- 待完成：
- Dashboard 端到端手工联调（当前环境 Docker daemon 未启动，无法本地 smoke）。
- 压力下事件保留/裁剪策略（Phase 5）。
