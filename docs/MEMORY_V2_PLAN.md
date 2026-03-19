# MolClaw Memory V2 Plan

## 1. 目的

本文件用于为 MolClaw 下一步的 memory 改造提供统一设计基线。

目标不是继续堆更多历史消息，而是把当前“按 group 复用 session”的机制，演进成一个真正分层、可观测、可治理的 memory 系统。

本计划同时参考了当前 MolClaw 实现，以及 `openclaw`、`claude-code`、`qwen-code` 在 memory、session、compaction、event streaming 方面的设计思路。

## 2. 当前 MolClaw Memory 现状

当前 MolClaw 的“memory”主要由 4 部分组成：

- `group -> session_id` 映射
  - 宿主进程只记录每个 group 当前绑定的 session id。
  - 数据位于 SQLite `sessions` 表。
- session transcript
  - 容器内将每个 session 的完整消息数组保存为 `/home/node/.claude/openai-sessions/<session>.json`。
  - 下一轮继续读取并回放。
- prompt fragment memory
  - 每轮请求会把 `CLAUDE.md` 片段拼进 system prompt。
  - 当前支持 group 级和 global 级 `CLAUDE.md`。
- observability data
  - `agent_events` 记录 provider/tool/context/lifecycle 事件。
  - 这些数据当前主要用于 dashboard 和日志，不参与记忆召回。

### 2.1 当前设计的优点

- 实现简单，容易理解。
- group 隔离明确，不容易串会话。
- reset session 语义清楚。
- dashboard 已经能观测 session、token、tool、round 等执行情况。

### 2.2 当前设计的核心问题

- 没有真正的长期记忆写入机制。
- 没有显式 memory scope。
- 没有语义压缩，只有 recent-tail trimming。
- 没有 retrieval，长期依赖 transcript 回放。
- 新 session 与旧 session 之间没有 summary bridge。
- `CLAUDE.md` 能承载规则和偏好，但缺少结构化写入、版本化和命中控制。

## 3. 与 OpenClaw / Claude Code / Qwen Code 的对比

### 3.1 OpenClaw

OpenClaw 对 MolClaw 的启发最大，因为 MolClaw 当前本质上就是一个更轻量的 OpenClaw/NanoClaw 路线。

从本地 `openclaw` 仓库可确认的关键设计：

- memory 的 source of truth 是工作区里的 Markdown 文件，而不是内存里的 transcript。
- 默认分成两层文件：
  - `MEMORY.md`
    - curated long-term memory
  - `memory/YYYY-MM-DD.md`
    - daily append-only running notes
- `MEMORY.md` 默认只在 main/private session 自动加载，不在 group/channel 场景全量注入。
- group/channel 场景需要通过 `memory_search` / `memory_get` 按需读取长期记忆，避免上下文污染。
- session 接近 auto-compaction 时，会先触发一次 silent memory flush，提醒模型把 durable memory 写到磁盘。
- memory 搜索后端是可替换的：
  - builtin sqlite index
  - qmd backend
  - embeddings/vector search
- session store 和 transcript 是两层持久化：
  - `sessions.json`
  - `*.jsonl`

OpenClaw 的核心价值不只是“有 memory search”，而是它把几个边界划得很清楚：

- transcript 不是长期记忆
- memory 是磁盘事实，不是模型 RAM
- group 场景默认应降低长期记忆自动注入强度
- compaction 前应该先做一次 durable memory flush

这些点对 MolClaw 都非常值得直接借鉴。

### 3.2 Claude Code

从本地 `claude-code` 仓库可确认的设计方向：

- 存在 auto-memory，并可通过 `/memory` 管理。
- 存在 auto compaction，目标是支持超长会话。
- 存在独立的 memory/rules 层，而不是只靠 transcript。
- 对 session resume、session naming、fork、context compaction 有完整体系。

Claude Code 的特点是：

- memory 更自动。
- compaction 更深度嵌入消息生命周期。
- rules/memory/session 三层边界更清楚。

Claude Code 的代价是：

- 系统复杂度更高。
- 很多能力是产品内建的，不适合直接照搬。

### 3.3 Qwen Code

从本地 `qwen-code` 仓库可确认的设计方向：

- 有显式 `save_memory` 工具。
- memory 有 `global` / `project` scope。
- 长期记忆落在 `QWEN.md` 等上下文文件。
- 有专门的 memory discovery 和 import 处理。
- session 独立存储，支持 list / resume / remove。
- 有 `/compress`，明确把历史上下文替换为 summary。
- 有结构化 session updates：
  - `agent_message_chunk`
  - `agent_thought_chunk`
  - `tool_call`
  - `tool_call_update`
  - `plan`

Qwen Code 的特点是：

- memory 模型更显式。
- scope 更清楚。
- ACP event 结构很适合作为 dashboard/SDK/IDE 的统一输出。

### 3.4 对 MolClaw 的启发

MolClaw 不适合完全复制任一系统。

更合适的方向是：

- 借 OpenClaw 的“Markdown source of truth + on-demand memory tools + pre-compaction flush”思路。
- 借 Claude Code 的“分层 memory + compaction”思路。
- 借 Qwen Code 的“显式 scope + 明确工具 + 结构化事件”思路。
- 保留 MolClaw 自己最重要的特性：
  - 多 group
  - 容器隔离
  - per-group workspace
  - dashboard 可观测

## 4. Memory V2 设计目标

Memory V2 需要满足以下目标：

- 不让单个 group 长时间聊天后上下文持续污染。
- 当前 session 过长时，可以平滑滚动压缩，而不是只能粗暴截断。
- 新 session 默认应允许完全干净启动，只有在明确需要时才继承必要信息。
- 用户偏好、项目规则、运行约束可以长期保存并被稳定加载。
- dashboard 可以清楚展示：
  - 当前 prompt 实际带了哪些 memory
  - 各层 memory 的 token 占用
  - 本轮命中了哪些 memory
- 后续可以平滑扩展到更高级的 retrieval，而不推翻已有结构。

## 5. 目标架构

Memory V2 建议拆成 4 层。

### 5.1 Layer A: Working Memory

这是当前 query 直接送给 provider 的“近期高保真上下文”。

包含：

- 最近若干轮 user / assistant / tool 消息
- 当前未完成的任务状态
- 当前 round 的 tool outputs

特点：

- 高保真
- 生命周期短
- token 成本最高

实现约束建议：

- 对单个 Tool Output 需要有硬上限，避免一次网页抓取、长文档读取、大 JSON 输出直接击穿 working memory 预算。
- 对超大 tool result 建议采用：
  - 截断后保留头尾 + metadata
  - 生成工具摘要
  - 或仅保留引用句柄（reference），正文写文件/事件存储
- `agent_events` 可保留完整输出或较长输出，但进入 provider context 的版本必须是受控的。

### 5.2 Layer B: Session Memory

这是某个 session 的压缩表达，不再是完整 transcript。

建议包含：

- session summary
- important facts
- unresolved questions
- generated artifacts
- tool-produced findings
- follow-up suggestions

特点：

- 一个 session 一份或多份 summary snapshot
- 用于新 session 承接旧 session 的必要上下文
- 比 transcript 便宜得多

### 5.3 Layer C: Durable Memory

这是长期存在的结构化记忆。

建议参考 OpenClaw，采用“文件层 + 结构化索引层”的双层设计：

- 文件层
  - `MEMORY.md`
  - `memory/YYYY-MM-DD.md`
- 索引层
  - SQLite / FTS / embeddings index
  - 仅用于召回和 dashboard，不替代文件内容本身

也就是说：

- 对人类和 agent 来说，长期记忆首先是工作区里可读可编辑的文件。
- 对系统来说，结构化表和索引是加速层，不是唯一 source of truth。

建议至少支持以下 scope：

- `global`
  - 跨所有 group 生效
  - 例如通用行为规则、默认输出偏好、全局 provider 限制
- `group`
  - 对某个 Discord/WhatsApp 群长期生效
  - 例如本群常见项目、偏好输出格式、长期研究主题
- `project`
  - 与工作区 / repo 绑定
  - 例如实验规范、路径约定、代码规范
- `user`
  - 后续可选
  - 如果未来需要区分群内多个用户偏好，可以再加

特点：

- 需要显式写入
- 需要人工可编辑
- 需要可审计
- 需要可以导出回 Markdown 文件

### 5.4 Layer D: Rules / Instructions

这是 system prompt 级别的静态或半静态规则层。

例如：

- `CLAUDE.md`
- `AGENTS.md`
- 后续的 `GROUP.md`

注意：

- `MEMORY.md` 更适合视为 durable memory 文件，而不是单纯 rules 文件。
- `AGENTS.md` / `CLAUDE.md` 更适合放规则、约束、默认行为。

## 6. 建议的数据模型

### 6.1 保留现有表

保留：

- `sessions`
- `agent_events`
- `registered_groups`

这些表仍然有价值。

### 6.2 新增表：`memory_entries`

建议新增结构化长期记忆表：

```sql
CREATE TABLE memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  tags_json TEXT,
  source TEXT NOT NULL,
  confidence REAL,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

字段建议：

- `scope`
  - `global` / `group` / `project` / `user`
- `scope_id`
  - 例如 `global`, `discord-dm-xxx`, repo path hash, user id
- `kind`
  - `preference`, `rule`, `fact`, `project_context`, `artifact_note`, `summary`
- `source`
  - `manual`, `tool`, `session_rollup`, `imported`
- `pinned`
  - 强制优先注入
- `archived`
  - 逻辑删除或降权
- `hit_count`
  - 被命中的次数，用于后续热度排序
- `last_accessed_at`
  - 最后一次命中时间，用于后续衰减/淘汰策略

### 6.3 新增表：`session_summaries`

建议为 session 单独建 summary 表：

```sql
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  summary_type TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
  round_start INTEGER,
  round_end INTEGER,
  created_at TEXT NOT NULL
);
```

用途：

- 存 session 压缩结果
- 支持 session 结束后迁移
- 支持 dashboard 回看 session boundary

### 6.4 新增表：`memory_hits`

建议记录每轮实际命中的 memory：

```sql
CREATE TABLE memory_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  session_id TEXT,
  round INTEGER,
  memory_entry_id INTEGER,
  injection_layer TEXT NOT NULL,
  reason TEXT,
  token_count INTEGER
);
```

用途：

- dashboard 展示“本轮到底带了哪些 memory”
- 后续做命中分析、清理无效记忆
- 每次命中后可异步回写 `memory_entries.hit_count` 和 `last_accessed_at`

### 6.5 文件层布局

参考 OpenClaw，建议在 workspace 内增加以下 memory 文件布局：

- `groups/<group>/MEMORY.md`
  - curated durable memory
- `groups/<group>/memory/YYYY-MM-DD.md`
  - daily running notes
- `groups/global/MEMORY.md`
  - 全局 durable memory
- `groups/global/memory/YYYY-MM-DD.md`
  - 全局 daily notes

其中：

- `MEMORY.md` 代表相对稳定、可整理、值得长期保留的内容
- `memory/YYYY-MM-DD.md` 代表当天或当前阶段的运行记录

这比“把所有东西都扔进 session summary 或 transcript”更接近 OpenClaw，也更利于人工维护

## 7. Prompt Assembly 改造

当前 MolClaw 基本是：

- system prompt
- prompt fragments
- trimmed transcript

Memory V2 建议改成：

1. system rules
2. static instructions
3. selected durable memories
4. selected session summary
5. recent working-memory transcript
6. current user message

这里需要强调：`selected session summary` 的主要职责，不是跨 session 继承，而是当前 session 内 rolling compression 后留下的“前情提要”。

### 7.3 自动注入原则

这一点建议直接借 OpenClaw，而不要再沿用“什么都塞进 prompt”：

- `AGENTS.md` / `CLAUDE.md`
  - 默认自动注入
- `MEMORY.md`
  - DM / private session 可自动注入少量核心内容
  - group session 默认不要整文件注入
- `memory/YYYY-MM-DD.md`
  - 默认不整文件注入
  - 通过检索或 session summary 按需注入

原因：

- 群聊天然更容易发生上下文污染
- 长期记忆越稳定，越应该按需引用，而不是每轮强灌
- 每日运行日志更像 working notes，不适合作为系统 prompt 常驻部分

### 7.1 注入顺序建议

- `rules`
  - 放最前面
- `durable memory`
  - 放在 rules 后
- `session summary`
  - 放在 recent transcript 前
- `recent transcript`
  - 保留高保真最近轮次

### 7.2.1 冲突解决原则

仅有注入顺序还不够，Prompt 结构本身也要明确优先级。

建议使用显式分隔标签，例如：

```xml
<absolute_constraints>
...
</absolute_constraints>

<user_preferences_and_context>
...
</user_preferences_and_context>

<current_session_summary>
...
</current_session_summary>
```

并在系统提示中明确声明：

- 当 `user_preferences_and_context` 与 `absolute_constraints` 冲突时，绝对服从 `absolute_constraints`
- `current_session_summary` 是压缩后的上下文，不得覆盖显式规则

### 7.2 注入预算建议

每层都要有预算上限，而不是统一抢 token。

例如：

- rules: 2k tokens
- durable memory: 2k tokens
- session summary: 2k tokens
- recent transcript: 8k to 32k tokens

具体预算由模型 context window 决定。

### 7.4 Tool Output 进入上下文的策略

Working memory 不应该无差别接纳全部 tool 输出。

建议：

- 单条 tool result 设置 `max_tool_output_tokens`
- 超限时采用以下三选一：
  - `truncate`
  - `summarize`
  - `reference-only`

推荐默认策略：

- 文本型工具：头尾截断 + 中间省略标记
- 结构化大对象：提取 schema/keys/统计摘要
- 网页/长文档：摘要 + 原文文件路径
- 二进制/图像分析：只保留说明、路径和必要元数据

这样 Recent Transcript 才能保持结构稳定。

## 8. 写入路径设计

### 8.1 显式写入

新增 memory tool，建议名称：

- `save_memory`
- 或 `remember_fact`
- `memory_search`
- `memory_get`

参数建议：

- `scope`
- `kind`
- `content`
- `title`
- `tags`
- `pinned`

优先只做显式写入，不建议一开始就做强自动写入。

其中写入规则建议参考 OpenClaw：

- durable facts / preferences / rules
  - 写 `MEMORY.md`
- running notes / current investigation / daily observations
  - 写 `memory/YYYY-MM-DD.md`

### 8.2 自动写入

第二阶段再做自动提取，触发条件建议以 token 预算为主，而不是单纯按轮次：

- 当前 transcript 超过 `working_memory_limit`
- session reset
- idle 超时
- scheduler 任务完成

自动写入只产出：

- session summary
- candidate facts

不要直接自动写 durable memory，先进入 candidate 状态更稳。

但建议额外加入一个 OpenClaw 风格的机制：

- pre-compaction memory flush
  - 在 session 接近 compaction 或即将 reset 时
  - 插入一轮 silent/internal prompt
  - 提醒模型把 durable 信息落盘
  - 默认不向用户产生回复

### 8.2.0 Silent Flush 输出约束

Silent flush 不是普通对话轮次，它的目标是触发 memory 写入，而不是生成自然语言回复。

因此必须强约束输出格式：

- silent flush prompt 必须明确声明：
  - 当前处于记忆压缩阶段
  - 严禁输出解释性文本
  - 严禁输出任何面向用户的自然语言
  - 仅允许发起 `save_memory` 工具调用
- 如果本轮没有值得写入的内容：
  - 返回空工具集
  - 或返回严格受控的空结果标记
  - 但不允许生成“我已经总结如下”之类文本

实现建议：

- 给 silent flush 单独的 prompt mode
- 在 system instruction 中写死：
  - `Only emit tool calls. Do not emit conversational text.`
- 在事件层把这类轮次标记为 housekeeping / silent，避免污染普通 timeline

### 8.2.1 Rolling Compression

这里建议把设计重心从“跨 Session 继承”转向“当前 Session 的滚动压缩”。

推荐策略：

- 设定 `working_memory_limit`
  - 例如 24k tokens
- 每次 prompt assembly 前统计当前 transcript token
- 当超出阈值时触发 compaction

compaction 动作采用：

- `旧 summary + 被挤出安全线的老对话 -> 新 summary`
- 永远保留最近 `N` 轮高保真 recent tail
- 用新 summary 替换更老的历史上下文

为避免 summary 和 recent tail 之间出现“语义断层”，建议加入 anchor：

- 在送去做压缩的输入中：
  - 带上旧 summary
  - 带上被挤出的老对话
  - 再额外带上 1-2 轮当前 recent tail 作为衔接锚点
- 压缩 prompt 中明确要求：
  - 新 summary 必须与这些最新轮次平滑衔接
  - 不要重复 recent tail 的细节
  - 重点保留会影响后续理解的未完成事项、约束、结论和实体

建议默认形态：

- `Current Session Summary`
  - 持续滚动更新
- `Recent Transcript`
  - 最近 5-10 轮原汁原味保留

这样即使对话达到 100 轮，provider 看到的输入依然稳定：

1. System Rules
2. Durable Memory
3. Current Session Summary
4. Recent Transcript
5. Current User Message

这比“到新 session 再继承旧内容”更符合实际聊天体验。

### 8.3 文件与数据库关系

这里建议明确采用 OpenClaw 路线：

- Markdown 文件是人类可维护 source of truth
- SQLite / index 是系统加速层

也就是说：

- `MEMORY.md` / `memory/*.md` 不应该只是“导出视图”
- 它们应该是真正的一等对象
- 数据库用于：
  - 记录 metadata
  - 建索引
  - 统计命中
  - 支持 dashboard

## 9. 读取与召回策略

MVP 阶段不需要上 vector DB。

建议先做 deterministic retrieval：

- 永远加载 pinned memories
- 加载最近更新的少量 durable entries
- 根据当前 prompt 关键字做简单匹配
- 根据 group / project scope 做硬过滤
- 先通过宽容的 `memory_search`
- 再通过 `memory_get(id)` 精准读取完整内容

这已经足够比当前 transcript replay 强很多。

### 9.1 两步检索策略

`memory_search` / `memory_get` 应严格按两步走设计，而不是让模型一次把检索和全文读取都做完。

推荐接口语义：

- `memory_search(query, scope?, limit?)`
  - 做宽容匹配
  - 支持：
    - FTS5
    - 模糊 LIKE
    - 前缀/关键词匹配
  - 返回：
    - `id`
    - `title`
    - `kind`
    - `scope`
    - `short_preview`
    - 可选 `score`
- `memory_get(id)`
  - 只按 id 取完整内容
  - 避免模型自己猜 path、scope_id、文件名或精确关键词

这样做的优势：

- `memory_search` 可以非常宽容，优先召回候选项
- `memory_get` 保持精确，减少 token 浪费
- 模型不需要自己构造复杂路径或猜 scope
- 后续从 SQLite 切换到 FTS / embeddings / hybrid search 也不影响工具接口

第二阶段可再加：

- sqlite FTS
- embedding retrieval
- hybrid ranking

## 10. Session 生命周期设计

### 10.1 新 session

当用户执行 `/newsession` 或 dashboard `New Session` 时：

- 切断当前 `group -> session_id`
- 创建新 session
- 默认不继承旧 transcript
- 默认应为 fresh start
- 仅在用户明确选择“带上下文新会话”时，才继承：
  - relevant durable memory
  - latest session summary

如果启用了 reset hook，还应：

- 将上一个 session 的尾部内容导出到 `memory/YYYY-MM-DD-<slug>.md`
- 或至少写入当天 daily log

这个点可以直接借鉴 OpenClaw 的 session-memory hook 模式

设计原则：

- `/newsession`
  - 默认是“真新会话”
- rolling compression
  - 才是长对话 continuity 的主路径

### 10.2 老 session 收尾

session reset 时应考虑自动做：

- 生成 closing summary
- 提取 unresolved tasks
- 记录重要 artifact

这一步是 MolClaw 从“会话切断”升级为“会话收束”的关键。

### 10.3 Scheduled Task

当前 scheduler 已有 `group` / `isolated` 两种模式。

Memory V2 应延续这个设计：

- `group`
  - 共享 group 当前 session summary 和 durable memory
- `isolated`
  - 不读 working memory
  - 可以只读 pinned durable memory

## 11. Dashboard 联动

Memory V2 必须从一开始就考虑 dashboard。

建议新增以下展示面板：

- Current Context Stack
  - rules
  - durable memory
  - session summary
  - recent transcript
- Memory Hits
  - 本轮命中的 memory 条目
  - scope / kind / token
- Session Boundary
  - 当前 group 的各个 session 分隔展示
- Memory Inspector
  - 查看、编辑、归档某条 durable memory
- File-backed Memory View
  - 直接展示 `MEMORY.md` 和 `memory/YYYY-MM-DD.md` 的来源关系

建议新增 API：

- `GET /api/memory?scope=&scope_id=`
- `POST /api/memory`
- `PATCH /api/memory/:id`
- `GET /api/session-summaries?chat_jid=`
- `GET /api/memory-hits?chat_jid=&session_id=`

## 12. 推荐实施顺序

### Phase 1: 基础数据层

- 新增 `memory_entries`
- 新增 `session_summaries`
- 新增 `memory_hits`
- 保持现有 session 机制不变

### Phase 2: 显式记忆工具

- 加 `save_memory`
- 加 `memory_search`
- 加 `memory_get`
- dashboard 支持浏览 memory entries
- 支持 group/global/project scope

### Phase 3: Session Summary

- 在当前 session 达到 token 阈值时滚动更新 summary
- session reset 时补一次 closing summary
- reset/new 时可选导出到 daily memory file

### Phase 4: Prompt Assembly 重构

- 将 provider 输入改为多层装配
- 给每层单独 token budget
- dashboard 显示每层 token 占用
- group session 默认改为“按需 memory retrieval”而不是自动全量注入 durable memory
- 对单个 tool output 增加硬截断 / 摘要 / 引用机制

### Phase 5: 基础检索

- pinned + recent + keyword match
- 记录 memory hits
- 观察命中效果

### Phase 6: 自动提取

- 从结束 session 自动抽取 candidate memories
- 增加审核或确认机制
- 增加 pre-compaction memory flush

### Phase 1-5 强化项

即使暂时不进入 Phase 6，Phase 1-5 本身仍有一批必须补强的点。

这些强化项的目标是：

- 让 compaction 行为更稳定
- 让 durable memory 回填更可解释
- 让 context 接近满载时的行为更可控
- 让 dashboard 能真正解释“为什么模型看到了这些上下文”

#### 1. 统一 Context Assembler

当前 prompt assembly 即使已经引入多层 memory，也仍然更接近“多处 heuristic 叠加”而不是一个统一调度器。

建议后续将 provider 输入重构为单一 `ContextAssembler`，显式管理：

- rules budget
- durable memory budget
- session summary budget
- recent transcript budget
- tool output budget

每层都应有：

- soft budget
- hard budget
- overflow strategy
- priority

并输出结构化的 assembly result，供 dashboard 直接展示。

这样在 context 快接近上限时，系统行为才可预测，而不是依赖分散的截断逻辑。

#### 2. Working Memory 的超大输出治理

当前已经有 tool output truncation，但离稳定态还不够。

应继续补上：

- 单个 tool output 的结构化摘要策略
- reference-only 模式
  - provider context 里只放摘要和句柄
  - 完整原文写入文件、event store 或 artifact
- 不同工具类型使用不同压缩器：
  - 文本输出：头尾保留
  - 结构化输出：keys/schema/stats
  - 网页/文档：摘要 + 路径
  - 大型代码 diff：变更摘要 + 文件引用

目标不是“少传一点”，而是让 recent transcript 的结构长期稳定。

#### 3. Session Summary 固定 schema

当前 rolling summary / closing summary 还是自由文本，这会导致：

- 不同轮次 summary 风格不一致
- 后续注入时不好做 selective reading
- dashboard 不容易结构化展示

建议逐步收敛到固定 schema，例如：

- `facts`
- `decisions`
- `artifacts`
- `open_questions`
- `next_steps`
- `user_preferences`

并要求：

- rolling summary 与 closing summary 尽量共享 schema
- summary 必须显式区分已确认结论与待确认事项
- 不重复 recent tail 的细节

这样 summary 更像压缩态 working memory，而不是泛化的自由总结。

#### 4. 检索从启发式升级到 deterministic ranking

当前 retrieval 已经有 `pinned + recent + keyword match`，这是可用 MVP，但还不够稳。

下一步建议：

- 引入 SQLite FTS5
- 保留 `memory_search -> memory_get` 两步走接口
- 排序时加入：
  - scope 优先级
    - group > project > global
  - pinned boost
  - recent update boost
  - hit_count / last_accessed_at boost
  - title / tags / kind 高权重

目标是：

- provider 自动注入使用同一套 deterministic ranking
- dashboard 能解释为什么某条 memory 被选中
- 后续如果切 embeddings/hybrid，也不需要改工具接口

#### 5. Memory Lifecycle 治理

当前 durable memory 已经能存，但还没有形成完整 lifecycle。

建议在 Phase 1-5 范围内继续补：

- pin / unpin
- archive / unarchive
- edit title/content/tags
- stale memory 降权
- dedupe / merge 建议

并逐步引入更完整状态：

- candidate
- accepted
- archived

即使 Phase 6 暂时不做自动抽取，生命周期治理也应该先准备好，否则 durable memory 会很快变脏。

#### 6. Pre-compaction Silent Flush 的质量控制

Silent flush 当前已经是正确方向，但要接近 Claude/OpenClaw 的稳定性，还需要进一步收紧：

- flush prompt 使用单独模板
- 明确限制：
  - 最多允许写几条 memory
  - 每条 memory 的最大长度
  - 允许的 kind 集合
- flush 结果进入质量检查：
  - 过滤低信息量、重复、泛泛而谈的 memory
- flush 失败不阻断主流程
- 但必须产出清晰 observability：
  - started
  - tool-only
  - saved count
  - filtered count
  - failed reason

这一步是从“模型可能会写 memory”升级到“系统能稳定利用 flush”。

#### 7. Dashboard 从“看到 hit”升级到“解释 hit”

当前 dashboard 已经能展示 memory hits、summary、session 边界，但还不够解释性。

建议继续补：

- Current Context Stack
  - rules
  - selected durable memory
  - session summary
  - recent transcript
  - tool-output summaries
- 对每条 injected memory 显示：
  - why selected
  - score
  - layer
  - token cost
  - rounds used
- 显示被裁剪掉的上下文层
- 显示 compaction 前后 token 对比
- 区分：
  - auto injected durable memory
  - explicit `memory_get`
  - silent flush writes
  - session summary reuse

如果没有这一层 observability，后续 memory 行为很难调稳。

#### 8. 配置与 migration 也属于 Phase 1-5 强化范围

除了 runtime 逻辑，还应补齐基础工程设施：

- 为 memory budgets 暴露明确 env 示例
- 为 schema 增加显式 version / migration 路径
- 增加 file-backed memory 与 SQLite index 的 resync 机制
- 增加 repair / rebuild 命令

这些能力不会直接改变模型行为，但会决定这套 memory 系统能否长期维护。

#### 建议执行顺序

如果 Phase 6 暂缓，建议接下来的执行顺序为：

1. 统一 `ContextAssembler`
2. 固定 `Session Summary schema`
3. 引入 FTS5 + deterministic ranking
4. 完善 tool output reference / summarize 模式
5. 补 Memory Lifecycle CRUD / archive / pin / dedupe
6. 升级 dashboard 的 memory observability

这样即使不做自动 candidate extraction，系统也已经能从“可用”走向“稳定可治理”。

## 13. 不建议现在就做的事情

以下内容先不要做，否则复杂度会陡增：

- 一上来就接 embedding/vector DB
- 完全自动把模型输出写进 durable memory
- 把所有 transcript 全部结构化拆表
- 让 `CLAUDE.md` 和 DB 双向强一致

当前更合理的是先把 memory lifecycle 建起来，再考虑高级召回。

## 14. 核心设计判断

MolClaw 当前最大的问题，不是“记得不够多”，而是“缺少 memory 分层与边界”。

因此 Memory V2 的关键不是多存消息，而是：

- 区分 working memory / session memory / durable memory / rules
- 区分 session continuity 和 long-term memory
- 区分 transcript archive 和 provider context
- 区分 dashboard observability 和 actual memory injection
- 区分“自动注入的规则”与“按需检索的长期记忆”
- 区分“durable curated memory”与“daily running notes”

更具体地说：

- 长对话 continuity 主要靠 rolling compression
- 新 session 默认不是 continuity 机制，而是重置机制

如果这四组边界立住，后续加检索、加压缩、加用户级偏好都会顺很多。

## 15. MVP 建议

如果只做一个最小可落地版本，建议目标定为：

- 有结构化 `memory_entries`
- 有文件层 `MEMORY.md + memory/YYYY-MM-DD.md`
- 有 `save_memory`
- 有 `memory_search` / `memory_get`
- 有 `session_summaries`
- 有基于 token 预算的 rolling compression
- `/newsession` 默认是干净新会话，不自动继承旧 summary
- group 默认不自动全量加载 durable memory，而是按需检索
- 接近 compaction/reset 时能做一次 silent memory flush
- 单个 tool output 不会击穿 working memory
- dashboard 能看到本轮注入了哪些 memory

做到这里，MolClaw 的 memory 设计就会从“能续聊”升级成“能管理上下文”。
