# Route: Local Issue-Tracker Tool — Architecture Decision + Design Doc

## Destination

产出架构决策 + 设计文档，交给后续 session 实现。不产出代码实现。

## Scope

**目标**:
- 定义 issue-tracker 抽象数据模型（实体、属性、关系）
- 定义 local markdown 持久化方案（文件结构、YAML front matter schema）
- 设计 CLI 的操作接口（子命令、参数、返回格式、错误处理）

**非目标**:
- 不实现 CLI 代码（destination = 架构决策 + 设计文档）
- CLI 只实现 local 后端（D2）；但设计决策（triage 双字段、YAML front matter 格式等）全局生效，GitHub/GitLab tracker docs 的更新不在本次 scope，是 future work
- 不管 CI/CD 自动化（D3: out of scope）
- 不改造 skill 业务逻辑（D4: infra layer only）。**注意**：migration plan item 8 改变了 to-tickets 的 triage 默认行为（从 `ready-for-agent` 改为 null），这是数据模型驱动的修正（旧行为假设 triage=label，新模型分离 Status 与 Triage），不是 skill 业务逻辑变更
- 不考虑现有 .scratch 文件兼容性（Q12: 旧格式不兼容，需手动迁移或重建）。现有 .scratch 项目（如 odr-v01、slo-testing）需手动重建或迁移——本设计文档不提供自动迁移工具

**实现语言**: Go（Q19）

**产出文档**: 6 份（Q20）
1. Decision Record — 锁定的架构决策清单
2. Data Model Spec — 实体定义、属性、关系
3. CLI Interface Spec — 子命令定义、参数、返回格式、错误处理
4. Persistence Spec — 文件结构、YAML front matter schema、body 段约定
5. Navigation Metaphor Update — CONTEXT.md 的新增/修改术语
6. Skill Migration Plan — 各 skill 文件的具体修改

**不修改的文件**（确认 out of scope）:
- `settings.json` — Q17 决定不建 pi extension tool 层，不注册 tool，不改 settings
- `mcp-bridge.d.ts` / PiToolRegistration API — 不使用
- `issue-tracker-github.md` / `issue-tracker-gitlab.md` seed templates — GitHub/GitLab tracker docs 更新是 future work
- `to-tickets/SKILL.md` 的 `<issue-template>` 块（GitHub/GitLab 用）— 只改 `<local-ticket-template>`，issue-template 不变

## Decisions (23 条 + 9 条 grilling round 3)

| # | 决策 | 答案 |
|---|------|------|
| D1 | Destination 形态 | 架构决策 + 设计文档 |
| D2 | Tool 覆盖范围 | CLI 只实现 local 后端；设计决策全局生效，GitHub/GitLab tracker docs 更新是 future work |
| D3 | CI/CD | Out of scope |
| D4 | Skill 关系 | Infra layer only（CLI 是基础设施，skill 业务逻辑不变） |
| Q5 | Triage | 支持但非强制（双字段分离：Status 管执行状态，Triage 管分类状态） |
| Q8 | Ticket 元数据格式 | YAML front matter |
| Q9-r2 | 数据模型 | Tracker → Milestone → Map → Ticket + 派生视图 Frontier/Progress |
| Q11 | 时间戳 | Created + Claimed + Resolved 三个时间戳 |
| Q12 | 向后兼容 | 不考虑现有 .scratch 文件兼容性 |
| Q13 | Milestone 引入 | 引入，flat + front matter 引用 |
| Q14 | Ticket front matter 划分 | 结构化元数据在 FM，自由文本在 body |
| Q15 | Map front matter | Map 也用 FM |
| Q16 | 编号 | per-map 编号从 01 递增，文件名 NN-slug.md，FM id 为 source of truth |
| Q17 | Tool vs CLI | CLI binary，不建 pi extension tool 层 |
| Q18 | 判断原则 | Start with bash/CLI, promote to tool only when gating/rendering/auditing/parallelization needed |
| Q19 | 实现语言 | Go |
| Q20 | 文档结构 | 6 份文档 |
| Q21 | Map/Milestone 管理 | 分层管理：CLI 管 lifecycle + 确定性逻辑，skill 管 content |
| Q22 | 命令结构 | Resource-first（tracker ticket create，与 glab/gh 一致） |
| Q23 | 输出格式 | 默认 JSON |
| Q24 | Escape hatch | 不需要 |
| Q25 | CLI 命令清单 | 13 个子命令 |
| G1 | wontfix 位置 | 保留在 triage 5 roles，Status 为 open→claimed→resolved（3 个，不含 wontfix） |
| G1 | spec type | 不新增，wayfinder 保持 4 种 type |
| G2 | --set resolved | **已撤回**——允许 `--set resolved`，CLI 是 thin CRUD（类似 gh/glab），不绑定内容操作。Agent 按 issue-tracker-local.md 指引先填 ## Answer + 追加 map.md decision pointer，再设 resolved |
| G3 | gist 来源 | 新增 --gist 参数 |
| G4 | create body 模板 | CLI 只输出最小骨架（## Answer + ## Comments），模板由 issue-tracker-local.md 定义 |
| G5 | blocking 语义 | Replace (SET) |
| G6 | ## Answer | Fill 已有空 heading |
| G7 | commit convention | 放 issue-tracker-local.md，implement/SKILL.md 只保留通用引用 |
| G7a | blocking 解除 | 只有 resolved 解除，wontfix 不解除 |
| R3-Q1 | to-spec local publish | to-spec 调用 tracker ticket create，再用 bash/edit 填充 body |
| R3-Q2 | triage category | 不加 category 字段（YAGNI） |
| R3-Q3 | blocking 清空 | `--by ""` 表示清空 |
| R3-Q4 | list 过滤组合 | AND 组合，--triage null 合法 |
| R3-Q5 | Answer heading 缺失 | 报错，不自动插入 |
| R3-Q6 | .scratch/ 创建 | 自动创建 .scratch/（在 git root 或 cwd） |
| R3-Q7 | blocked_by 空表示 | 始终写 blocked_by: [] |
| R3-Q8 | map list 范围 | 默认包含所有（active + closed） |
| R3-Q9 | 并发访问 | last-write-wins，resolve 已 resolved 返回 exit 3 |
| G-Q1 | Package 结构 | cmd/ + domain package（tracker/），业务逻辑零 cobra 导入 |
| G-Q2 | Viper | 不用，只用 cobra（YAGNI） |
| G-Q3 | 文件系统抽象 | afero + MemMapFs |
| G-Q4 | 命令工厂 | NewRootCmd() + NewXxxCmd() 工厂函数 |
| G-Q5 | RunE | 所有命令用 RunE |
| G-Q6 | SilenceUsage/Errors | root 设 true，main 打印错误 |
| G-Q7 | 输出 | cmd.OutOrStdout() / cmd.ErrOrStderr() |
| G-Q8 | context | signal.NotifyContext + ExecuteContext + ctx 参数 |
| G-Q9 | sentinel errors | ErrNotFound/ErrAlreadyResolved/ErrCycleDetected/ErrHeadingMissing |
| G-Q10 | module path | github.com/peachest/pi-packages/tracker |
| G-Q1 | resolved→open reopen | B: 允许 reopen + replace map.md 中的旧 decision pointer |
| G-Q2 | reopen 时 resolved_at | A: 清空为 null（与 claimed→open 清空 claimed_at 一致） |
| G-Q3 | markdown.go 模块边界 | A: Ticket 01 不创建，Ticket 04 创建 |
| G-Q4 | dangling blocked_by | A: 创建时验证 ID 存在，不存在则拒绝（exit 1） |
| G-Q5 | ## Answer whitespace | A: `## Answer\n\n<answer>\n\n` 模板 |
| G-Q6 | Progress struct | B: 不含 frontier_size，独立 `ComputeFrontierSize` 函数 |
| G-Q7 | frontier 逻辑归属 | A: 提取到 Ticket 01 共享模块 `frontier.go` |
| G-Q8 | slug punctuation | A: 删除所有 ASCII 标点（除 hyphen），max 50 runes |
| G-Q9 | YAML key ordering | A: 强制固定顺序 |
| G-Q10b | enum validation | A: cobra 层验证 type/triage |
| G-Q11 | partial failure mock | C: 逻辑层面测试，不 mock 文件系统 |
| G-Q12 | reviewed 字段 | A: `reviewed_at` 时间戳 + CLI 强制（claim 前检查 reviewed_at != null） |
| G-Q13 | re-review | A: 不强制，CLI 只检查 reviewed_at != null |
| G-Q14 | 影响范围 | A: 所有 ticket 类型都有 reviewed_at，claim 前都强制 review |
| G-Q15 | CLI 定位 | Thin CRUD（类似 gh/glab）——只管 front matter 字段，不解析/修改 markdown body。Body 操作由 agent + issue-tracker-local.md 指引处理。撤回 G2，允许 --set resolved。删除 ticket resolve 命令和 Ticket 04 |

## DDD 分析

DDD 分析在 grilling session 内联执行（ddd-scope → ddd-discover → ddd-subdomains → ddd-contexts → ddd-model-review），产出未持久化为独立 artifact——词汇表和反术语清单直接记录在本 route 中。以下是分析结论。

### 通用语言词汇表

- **Tracker**: 一个 repo 的 local issue 追踪系统根（`.scratch/` 目录）。
- **Milestone**: 中长期目标，包含多个 Map。**借鉴 GitHub/GitLab milestone 概念，但与 to-epic skill 的 milestone 是不同概念**（见下方"术语调和"）。**本设计引入的新概念**——CONTEXT.md 的 Navigation Metaphor 原无此术语；Destination 的 avoid 列表原含 `milestone`，引入此实体后需移除。
- **Map**: 一个 effort 的决策空间和 ticket 容器（`.scratch/<slug>/map.md`）。对应 wayfinder skill 的 Map 概念（"the canonical artifact"）。
- **Ticket**: 一个决策或任务单元（`.scratch/<slug>/issues/NN-<slug>.md`）。对应 GitHub/GitLab 的 issue，但 local 语境下统一用 Ticket。**注意：目录名 `issues/` 保留**（与 issue-tracker-local.md 约定一致，改目录名破坏性太大）。
- **Ticket Type**: `research` / `prototype` / `grilling` / `task`。4 种，来自 wayfinder skill，**不新增 `spec`**——spec 是 to-spec skill 的独立产物（独立 issue，label `ready-for-agent`），不是 wayfinder 的 ticket type。实践中 wayfinder 可在找到路后调用 to-spec 产出实现 spec，再由 to-tickets 拆分 vertical trace bullet，但 spec 不进入 wayfinder 的 ticket 体系。
- **Status**: 执行状态 `open` → `claimed` → `resolved`。**3 个状态，不含 wontfix**——wontfix 保留在 Triage 中（见下）。wayfinder/to-tickets 产生的 ticket 在实际使用中不会变成 wontfix（都属于必须完成的功能需求的一部分）。
- **Triage**: 可选分类状态，5 个 roles：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。**与 triage-labels.md 和 triage/SKILL.md 定义的 5 个 state roles 完全一致，不做改动**。wayfinder/to-tickets 产生的 ticket 不填此字段（值为 null）。外部 inbound issue 可填。**省略 triage 字段等价于 `null`（untriaged），不是默认某个 role。** wontfix 作为 triage role 表示"will not be actioned"——外部 issue 被拒绝时的分类。
- **Blocking**: ticket 间依赖关系（A blocked by B 表示 B 必须先 resolved）。**blocking 解除条件：只有 `status=resolved` 解除 blocking**。wontfix 不解除 blocking——wayfinder ticket 不会 wontfix，如果将来外部 issue 参与 blocking 且被 wontfix，下游需手动移除该 blocker。
- **Frontier**: 派生视图——Map 内所有 `status=open` + `triage=null|ready-for-agent` + 所有 `blocked_by` ticket `status=resolved` 的 ticket 集合。**基础概念来自 wayfinder skill**（"the open, unblocked, unclaimed children — the edge of the known"）；`triage` 过滤条件是**本设计的扩展**（Q5 双字段分离后，frontier 需要考虑 triage 状态——只返回 ready-for-agent 或 untriaged 的 ticket）。
- **Progress**: 派生视图——Map 内 ticket 按 status 的统计（open/claimed/resolved 计数）。**本设计引入的概念**（无 terrain source，类似 GitHub/GitLab milestone 的 progress bar）。不持久化。
- **Resolution**: ticket 解决时记录的答案（`## Answer` 段）。
- **Decision Pointer**: Map Decisions-so-far 中的一行（gist + 链接）。

### 反术语清单

| 禁用词 | 禁用原因 | 推荐替代 |
|--------|----------|----------|
| Issue | GitHub/GitLab 平台特定术语。目录名 `issues/` 保留（改目录名破坏性太大），但概念层面统一用 Ticket | Ticket（概念）；`issues/`（目录名保留） |
| Milestone（to-epic 语境） | to-epic 的 milestone 是目录容器（`.scratch/<milestone>/<feature>/`），本设计的 Milestone 是元数据文件（`.scratch/.milestones/<slug>.md`）。**两者共存**——见下方"术语调和" | 本设计的 Milestone 用 `.scratch/.milestones/`；to-epic 的 milestone 保持其目录结构 |
| Epic | to-epic skill 的概念，与 Map 不同层 | Map |
| Effort / Feature | issue-tracker-local.md 同时使用 "feature"（`<feature-slug>/`）和 "effort"（`<effort>/map.md`）两个词指代同一层目录。统一为 Map | Map |
| Label | GitHub/GitLab 平台概念，local 用 Type + Triage + Status 三字段替代 | Type / Triage / Status |
| Backlog | CONTEXT.md Navigation Metaphor 中 Frontier 的 avoid 词（`_Avoid_: backlog, queue`），与 Frontier 不同义（Frontier 是当前可领取的） | Frontier |

### 术语调和：Milestone 与 to-epic

**问题**：to-epic skill 已定义 milestone（`.scratch/<milestone-slug>/` 目录容器，含 epic.md + feature 子目录），与本设计引入的 Milestone（`.scratch/.milestones/<slug>.md` 元数据文件）是不同概念，共享同名。

**调和方案**：两者共存于不同 pipeline stage：
- **to-epic 的 milestone**：用于 to-epic → to-prd → to-issues pipeline，是目录容器（`.scratch/<milestone>/<feature>/issues/`）。to-epic 的 milestone 不使用本设计的 Milestone 元数据文件。
- **本设计的 Milestone**：用于 wayfinder/to-tickets pipeline，是 Map 之上的中长期目标分组（`.scratch/.milestones/<slug>.md`），通过 Map front matter 的 `milestone:` 字段引用。
- **如果同一 repo 同时使用两个 pipeline**：to-epic 的 milestone 目录（`.scratch/<milestone-slug>/`）与本设计的 Map 目录（`.scratch/<map-slug>/`）在同级，本设计的 Milestone 元数据在 `.scratch/.milestones/`。两者不冲突——to-epic 目录内是 feature→issues 层级，本设计的 Map 目录内是 map.md + issues/ 层级。
- **CONTEXT.md 更新**：从 Destination 的 avoid 列表中移除 `milestone`（当前 `milestone` 被列为 Destination 的 avoid 词，引入 Milestone 实体后自相矛盾）。Destination 的 avoid 列表改为 `_Avoid_: goal, objective`。新增 `Milestone` 术语定义和 `Progress` 术语定义。

**CONTEXT.md 新增术语条目草案**（migration item 16 的具体内容）：

```markdown
- **Milestone**: A checkpoint above the Map — a named long-term goal containing multiple related Maps. Tracks progress across Maps (resolved / total). Distinct from Destination (the end of one Map) and Map (the decision index for one effort). Persistence: `.scratch/.milestones/<slug>.md`.
_Avoid_: phase, stage, sprint

- **Progress**: A derived view — ticket counts by status (open / claimed / resolved) within a Map or Milestone. Not persisted; computed on demand by CLI (`tracker map progress`, `tracker milestone progress`).
_Avoid_: stats, metrics
```

### wayfinder Map 的 decisions_so_far 表示

数据模型定义 `decisions_so_far` 为"结构化索引 `[{ticket_ref, gist}]`"，但 Map 文件格式中它是 markdown 文本（`- [title](link) — gist`）。**两者不矛盾**：markdown 文本是持久化形式，结构化索引是逻辑视图。agent 按 issue-tracker-local.md 指引用 bash/edit 追加一行 markdown 到 `## Decisions so far` 段（thin CRUD, G-Q15）；`map progress` 等查询命令解析 markdown 行提取结构化数据。wayfinder skill 的 Map body 模板保持 markdown 格式不变。

## Research 结论

两份 research 报告的结论**不完全一致**，需调和：

**第一份报告**（tool design best practices）§9 结论：推荐 pi extension tool，理由是"tool replaces fragile prompt-driven skill instructions with deterministic code"——即 tool 用确定性代码替代脆弱的 prompt 指令。

**第二份报告**（tool vs CLI architecture）结论：推荐 CLI binary，不建 tool 层，基于 Anthropic 的四个 promotion 标准（gating/rendering/auditing/parallelization）全部不适用于 local issue-tracker。

**调和——为什么 CLI 结论 prevailed**：
1. 第一份报告聚焦"如何设计好 tool"，预设了 tool 是答案；第二份报告聚焦"何时该用 tool vs CLI"，质疑了这个预设。
2. 第一份报告的 §9 建议基于"tool 替代脆弱的 prompt"的观察，但第二份报告指出 gh/glab CLI + skill prompt 模式已被验证有效——prompt 指令不一定是脆弱的，CLI + skill prompt 同样能提供确定性。
3. 第二份报告引入了 Anthropic 官方的 promotion 标准（"Start with bash for breadth. Promote to dedicated tools when you need to gate, render, audit, or parallelize the action"），四个标准全部不适用（local 文件操作无 security boundary、无 staleness checks、无 rendering 需求、无 scheduling 需求），这是第一份报告未考虑的决策框架。
4. Token 经济：每个 registered tool 550-1,400 tokens/turn standing cost；CLI 0 tokens。13 个操作作为 tool 会消耗 7K-18K tokens/turn。

**最终决策 Q17**：CLI binary，不建 pi extension tool 层。如果将来实践中 agent 不够积极使用 CLI，再考虑将少数高价值操作（如 `query frontier`）promote 为 tool。

## 数据模型

### 实体

**Tracker**（隐式，`.scratch/` 目录）
- 关系：1→N Map

**Milestone**（`.scratch/.milestones/<slug>.md`）
- 属性：`title`（string）, `description`（string, 自由文本）, `state`（`active`|`closed`）, `created_at`（timestamp）, `closed_at`（timestamp|null）
- 关系：1→N Map（通过 Map front matter `milestone:` 字段引用）

**Map**（`.scratch/<slug>/map.md`）
- 属性：`title`（string）, `state`（`active`|`closed`）, `milestone`（string|null, 引用 Milestone slug）, `destination`（自由文本, `## Destination` 段）, `notes`（自由文本, `## Notes` 段）, `decisions_so_far`（markdown 文本，逻辑上是 `[{ticket_ref, gist}]` 索引, `## Decisions so far` 段）, `not_yet_specified`（自由文本）, `out_of_scope`（自由文本）, `created_at`（timestamp）, `closed_at`（timestamp|null）
- 关系：N→1 Milestone（可选）, 1→N Ticket

**Ticket**（`.scratch/<slug>/issues/NN-<slug>.md`）
- 属性：`id`（string, 零填充 2 位, 如 `"03"`）, `title`（string）, `map`（string, 引用 Map slug）, `type`（`research`|`prototype`|`grilling`|`task`）, `status`（`open`|`claimed`|`resolved`）, `triage`（string|null: `needs-triage`|`needs-info`|`ready-for-agent`|`ready-for-human`|`wontfix`）, `reviewed_at`（timestamp|null, review-spec 通过后标记, claim 前必须非 null）, `body`（自由文本）, `answer`（自由文本, `## Answer` 段）, `comments`（`[{text, timestamp}]`, `## Comments` 段）, `created_at`（timestamp）, `claimed_at`（timestamp|null）, `resolved_at`（timestamp|null）
- 关系：N→1 Map, N→N Ticket（blocking: `blocked_by` 指向其他 ticket id）

**注意**：Ticket **没有** `milestone` 字段——Milestone 是 Map 级属性，Ticket 通过其 `map` 引用间接关联到 Milestone。

### 派生视图（不持久化）

- **Frontier** — `status=open` + `triage=null|ready-for-agent` + 所有 `blocked_by` ticket `status=resolved` 的 ticket 集合
- **Progress** — ticket 按 status 的计数（open/claimed/resolved）

### Lifecycle 转换

**Map/Milestone 初始状态**：由 skill 通过 bash 写入 `state: active`（CLI 不管创建）。

**Map/Milestone 关闭**：**仅手动**，通过 `tracker map state --set closed` / `tracker milestone state --set closed`。**不自动关闭**——即使所有 ticket resolved，Map 也不自动变 closed（wayfinder skill 的 resolve 流程不包含关闭 map；关闭 map 是显式决策）。

**Ticket 状态转换**：
- `open` → `claimed`：通过 `tracker ticket status --set claimed`（wayfinder claim 操作），自动写 `claimed_at`。**前置检查（G-Q12）**：`reviewed_at` 必须非 null，否则 exit 1。
- `claimed` → `open`：通过 `tracker ticket status --set open`（释放 claim），清空 `claimed_at`
- `open`/`claimed` → `resolved`：通过 `tracker ticket status --set resolved`，自动写 `resolved_at`。**Agent 职责**：按 issue-tracker-local.md 指引，先填 `## Answer` + 追加 map.md decision pointer，再设 resolved。CLI 不绑定内容操作（thin CRUD，与 gh/glab 一致）。
- **reopen**：`resolved` → `open`：通过 `tracker ticket status --set open`，清空 `resolved_at` 和 `claimed_at`（G-Q1/Q2/Q3）。Agent 按 issue-tracker-local.md 指引处理 map.md decision pointer（replace 或 remove）。
- **无 wontfix 状态转换**——wontfix 是 triage role，不是 execution status。wayfinder ticket 不会 wontfix。

**CLI 是 thin CRUD（G-Q15）**：CLI 只管 front matter 字段读写（status/triage/blocked_by/reviewed_at 等结构化字段），不解析或修改 markdown body 内容（`## Answer` 段、`## Decisions so far` 段等）。Body 内容操作由 agent 按 issue-tracker-local.md 指引用 bash/edit 完成，与 GitHub 模式一致（agent 用 `gh issue comment` 加答案、用编辑器改 body，gh 不管内容）。

**并发访问**：不加文件锁（last-write-wins）。`--set resolved` 一个已 resolved 的 ticket 返回 exit code 3：`Error: Ticket #03 is already resolved.` 第二个 session 看到错误后读 ticket 的 `## Answer` 段，发现有答案了，跳过。这和 GitLab 的 commit-close 模式一致——第二个 `Closes #n` 是 no-op。

## 持久化方案

### 目录结构

```
.scratch/
├── .milestones/
│   └── <milestone-slug>.md          # Milestone 元数据文件
├── <map-slug>/                       # Map 目录（flat，不嵌套在 milestone 下）
│   ├── map.md                        # Map 文件（front matter + body）
│   └── issues/
│       ├── 01-<slug>.md              # Ticket 文件
│       └── 02-<slug>.md
└── <another-map-slug>/
    ├── map.md
    └── issues/
```

### Ticket 文件格式

```yaml
---
id: "03"
title: Define GpuInstanceInterface
map: hgml-gi-ci-interface
type: task
status: open
triage: ready-for-agent
blocked_by: ["01", "02"]
created_at: 2026-08-13T10:30:00Z
claimed_at: null
resolved_at: null
---

# Define GpuInstanceInterface

## What to build
...

## Acceptance criteria
- [ ] ...

## Answer
（CLI 在 resolve 时写入此段）

## Comments
### 2026-08-13T11:00:00Z
agent: 开始实现...
```

**字段类型说明**：
- `id`: string，零填充 2 位（`"01"`, `"02"`, ..., `"10"`, `"11"`）。YAML 中用引号确保不被解析为 int。
- `blocked_by`: string 数组。**始终写 `blocked_by: []`（空数组），不省略字段**——空数组表示"无 blocker"，省略字段会造成解析歧义。
- `triage`: string 或 null。省略字段等价于 null。
- timestamps: ISO 8601 UTC（`2026-08-13T10:30:00Z`）。
- **Ticket 没有 `milestone` 字段**——Milestone 通过 Map 的 front matter 关联，Ticket 不直接引用 Milestone。

### Map 文件格式

```yaml
---
title: SLO Testing
state: active
milestone: inference-benchmarking
created_at: 2026-08-13T10:00:00Z
closed_at: null
---

## Destination
...

## Notes
...

## Decisions so far
- [ticket title](issues/01-foo.md) — one-line gist

## Not yet specified
...

## Out of scope
...
```

### Milestone 文件格式

```yaml
---
title: PPU MIG 设备插件
state: active
created_at: 2026-07-20T00:00:00Z
closed_at: null
---

## Description
PPU device plugin 完整对标 HAMi NVIDIA device plugin 的 MIG 功能
```

### Slug 生成规则

- **Map 和 Milestone 的 slug**：由 skill/人类在创建时确定（bash 创建目录/文件时命名）。CLI 不生成 Map/Milestone slug。
- **Ticket 文件名 slug**：CLI 从 `--title` 自动生成。规则：lowercase，空格转连字符，非 ASCII 字符保留，max 50 字符。标点（冒号、斜杠、点等）删除，连续连字符合并为单个，首尾连字符去除。
- `tracker ticket create --map <slug> --title "..."`：agent 提供 map slug 和 ticket title，CLI 从 title 生成文件名 slug。
- 示例：title `"Define GpuInstanceInterface"` → 文件名 `03-define-gpuinstanceinterface.md`；title `"Spec: PPU MIG 调度实现"` → 文件名 `04-spec-ppu-mig-调度实现.md`。

### 编号方案

- per-map 编号，从 `"01"` 递增。
- CLI 分配编号时扫描 `issues/` 目录下 front matter 中的最大 id + 1，零填充 2 位。
- 文件名 `NN-<slug>.md` 中的 NN 与 front matter `id` 一致。CLI 写入时两者同步。

## CLI Interface Spec

### 命令清单（12 个子命令）

```
# Ticket (5)
tracker ticket create --map <slug> --title "..." --type <type> [--blocked-by 1,2] [--triage <t>]
tracker ticket list --map <slug> [--status <s>] [--type <t>] [--triage <t>]
tracker ticket blocking --map <slug> --id <N> --by 1,2
tracker ticket status --map <slug> --id <N> --set <open|claimed|resolved>
tracker ticket triage --map <slug> --id <N> --set <triage>

# Map (3)
tracker map state --slug <slug> --set <active|closed>
tracker map progress --slug <slug>
tracker map list [--milestone <slug>]

# Milestone (3)
tracker milestone state --slug <slug> --set <active|closed>
tracker milestone progress --slug <slug>
tracker milestone list

# Query (1)
tracker query frontier --map <slug>
```

**命令设计决策**:
- **CLI 是 thin CRUD（G-Q15）**——只管 front matter 字段读写，不解析/修改 markdown body。`ticket resolve` 命令已删除（G2 撤回）；`ticket status --set resolved` 允许。Body 操作（`## Answer` fill、map.md decision pointer）由 agent 按 issue-tracker-local.md 指引用 bash/edit 完成，与 GitHub 模式一致（agent 用 `gh issue comment` 加答案，gh 不管内容）。
- `ticket status --set` 接受 `open|claimed|resolved`（G2 撤回，G-Q15）。`--set claimed` 前置检查 `reviewed_at != null`（G-Q12）。`--set open` on resolved = reopen（清空 resolved_at + claimed_at，G-Q1/Q2/Q3）。
- `ticket blocking --by 1,2` 是 **Replace (SET) 语义**——覆盖整个 blocked_by 数组，不是 append（G5 决策）。**清空所有 blocker 用 `--by ""`（空字符串）**，CLI 解析空值为 `blocked_by: []`（R3-Q3）。
- `ticket create` 只输出 front matter + 最小 body 骨架（`## Answer` + `## Comments`），**不管 body 模板**——body 段模板由 `issue-tracker-local.md` 定义，agent 自觉遵循（G4 决策）。body 段模板包括 type-specific 段（task=`## What to build` + `## Acceptance criteria` + `## Out of scope` + `## Testing`；research/grilling/prototype=`## Question`）以及 to-spec 产出的 spec ticket 使用的段（`## Problem Statement` + `## Solution` + `## Implementation Decisions` + `## Testing Decisions` + `## Out of Scope` + `## Further Notes`）——to-spec ticket type 为 task 但 body 使用 to-spec 自己的模板，不套用 task 模板。
- `ticket list` 的 `--status`、`--type`、`--triage` 过滤是 **AND 组合**。`--triage null` 合法，匹配 triage 字段为 null/省略的 ticket。`--status`、`--type` 同理支持对应枚举值（R3-Q4）。
- **ID 输入归一化**：`--id <N>` 和 `--by 1,2` 接受 unpadded（`3`）或 padded（`03`）整数。CLI 内部归一化为零填充 2 位字符串匹配 front matter。输出始终为零填充 2 位字符串。
- **`query frontier` 排序**：返回的 JSON 数组按 ticket id 升序排列（与 wayfinder "first by number wins" 一致）。
- `map list` 默认包含所有 maps（active + closed），JSON 输出中有 `state` 字段区分。不加 `--state` 过滤（R3-Q8）。

### 输出格式

默认 JSON（Q23）。所有命令输出 JSON 到 stdout。

### 返回 JSON Schema

**ticket create**:
```json
{"id": "03", "title": "Define GpuInstanceInterface", "map": "hgml-gi-ci-interface", "type": "task", "status": "open", "path": ".scratch/hgml-gi-ci-interface/issues/03-define-gpuinstanceinterface.md", "blocked_by": ["01", "02"], "triage": null, "created_at": "2026-08-13T10:30:00Z"}
```

**ticket status (resolved)**:
```json
{"id": "03", "map": "hgml-gi-ci-interface", "status": "resolved", "resolved_at": "2026-08-13T12:00:00Z"}
```

**ticket list**:
```json
[{"id": "01", "title": "...", "type": "task", "status": "resolved", "triage": null, "blocked_by": []}, {"id": "02", "title": "...", "type": "research", "status": "open", "triage": "ready-for-agent", "blocked_by": ["01"]}]
```

**ticket blocking**:
```json
{"id": "03", "map": "hgml-gi-ci-interface", "blocked_by": ["01", "02"], "cycle_detected": false}
```

**ticket status**:
```json
{"id": "03", "map": "hgml-gi-ci-interface", "status": "claimed", "claimed_at": "2026-08-13T11:00:00Z"}
```

**ticket triage**:
```json
{"id": "03", "map": "hgml-gi-ci-interface", "triage": "ready-for-agent"}
```

**query frontier**:
```json
[{"id": "02", "title": "...", "type": "research", "status": "open", "triage": "ready-for-agent", "blocked_by": []}, {"id": "04", "title": "...", "type": "task", "status": "open", "triage": null, "blocked_by": []}]
```

**map state**:
```json
{"slug": "slo-testing", "title": "SLO Testing", "state": "closed", "closed_at": "2026-08-20T00:00:00Z"}
```

**map progress**:
```json
{"slug": "slo-testing", "title": "SLO Testing", "state": "active", "milestone": "inference-benchmarking", "progress": {"open": 2, "claimed": 1, "resolved": 3, "total": 6}, "frontier_size": 2}
```

**map list**:
```json
[{"slug": "slo-testing", "title": "SLO Testing", "state": "active", "milestone": "inference-benchmarking", "progress": {"open": 2, "claimed": 1, "resolved": 3, "total": 6}}]
```

**milestone state**:
```json
{"slug": "ppu-mig-device-plugin", "title": "PPU MIG 设备插件", "state": "closed", "closed_at": "2026-08-20T00:00:00Z"}
```

**milestone progress**:
```json
{"slug": "ppu-mig-device-plugin", "title": "PPU MIG 设备插件", "state": "active", "maps": ["mig-integration", "dynamic-reconfig", "health-monitor"], "progress": {"open": 5, "claimed": 2, "resolved": 8, "total": 16}}
```

**milestone list**:
```json
[{"slug": "ppu-mig-device-plugin", "title": "PPU MIG 设备插件", "state": "active", "map_count": 3}, {"slug": "hgml-infra", "title": "HGML/Hglib 基础设施", "state": "closed", "map_count": 2}]
```

### 错误处理

**原则**：永不 panic，返回可操作的错误信息到 stderr，exit code 非零。

**Exit codes**:
- 0: 成功
- 1: 用户错误（参数缺失、格式错误、ticket 不存在、`## Answer` heading 缺失）
- 2: 未找到（.scratch/ 不存在、map 不存在）
- 3: 冲突（循环 blocking、ticket 已 resolved）

**错误信息格式**（stderr）：
```
Error: <可操作的描述>
Available: <可用选项或修复建议>
```

**示例**：
- Ticket 不存在：`Error: Ticket #99 not found in map 'slo-testing'. Available tickets: #01-#06. Run 'tracker ticket list --map slo-testing' to see all tickets.`
- 循环 blocking：`Error: Cannot set blocking: ticket #03 → #01 → #03 creates a cycle. Remove #01 from blocked_by or check if #01 should block #03 instead.`
- Map 不存在：`Error: Map 'nonexistent' not found. No .scratch/nonexistent/ directory. Run 'tracker map list' to see available maps.`
- .scratch/ 不存在（自动创建前的检查）：如果 git root 或 cwd 不可写，报错：`Error: Cannot create .scratch/ directory at <path>: permission denied.`
- Ticket 已 resolved：`Error: Ticket #03 is already resolved. Cannot change status of a resolved ticket. Use 'tracker ticket status --set open' to reopen first.`
- `--set resolved` 允许（G2 撤回，G-Q15）：`tracker ticket status --map <slug> --id <N> --set resolved`。Agent 负责先填 `## Answer` + 追加 map.md decision pointer（见 issue-tracker-local.md）。
- `## Answer` heading 缺失（R3-Q5）：`Error: Expected '## Answer' heading not found in ticket file.`——agent 用 bash/edit 手动加，或重新 create。

### Resolve 工作流（G-Q15：thin CRUD，不是原子操作）

resolve 不再是一个原子 CLI 命令。流程（由 issue-tracker-local.md 指引 agent）：
1. Agent 用 bash/edit 填 `## Answer` 段（G6：覆盖已有内容，最终答案不留草稿）
2. Agent 用 bash/edit 在 map.md `## Decisions so far` 追加/替换 decision pointer 行：`- [#<id> <title>](issues/<NN>-<slug>.md) — <gist>`（replace 按 `- [#<id>` 前缀匹配，G-Q1）
3. `tracker ticket status --map <slug> --id <N> --set resolved`（写 resolved_at）

`## Answer` 和 `## Decisions so far` heading 缺失时，agent 按 R3-Q5 的错误信息手动处理（ticket 文件用 create 重新生成，map.md 从 wayfinder 模板补）。

### `ticket create` 后的文件内容

CLI create 后的文件（front matter + **最小 body 骨架**，不含 type-specific 段）：

```yaml
---
id: "03"
title: Define GpuInstanceInterface
map: hgml-gi-ci-interface
type: task
status: open
triage: null
blocked_by: ["01", "02"]
created_at: 2026-08-13T10:30:00Z
claimed_at: null
resolved_at: null
---

# Define GpuInstanceInterface

## Answer

## Comments
```

**CLI 不管 body 模板**（G4 决策）——`## What to build` / `## Question` / `## Acceptance criteria` 等 type-specific 段由 agent 根据 `issue-tracker-local.md` 中定义的模板自行添加。CLI 只预置所有 type 共有的 `## Answer`（resolve 时 fill）和 `## Comments`（agent 追加）。

### CLI 安装与 .scratch/ 发现

**安装**：`go install`（单二进制，与 gh/glab 模式一致）。项目可选在 Makefile 加 `make tracker` 目标从源码构建。

**.scratch/ 发现与创建**：
1. 从 cwd 向上搜索第一个包含 `.scratch/` 的目录。如果找到，使用它。
2. 如果找不到，**自动创建** `.scratch/` 在 **git root**（`git rev-parse --show-toplevel` + `.scratch/`）。如果不在 git 仓库中，创建在 cwd。
3. `.scratch/<map-slug>/` 目录不存在时报错（exit code 2）——map 目录由 skill/人类通过 bash 创建（写 map.md 时 `mkdir -p`）。
4. `.scratch/<map-slug>/issues/` 子目录不存在时**自动创建**——map 目录存在说明 map 已创建，issues/ 是它的子结构。

## Skill Migration Plan

以下 skill 文件需要更新。**设计决策全局生效**（D2 更新后），但 GitHub/GitLab tracker docs 的更新是 future work。

| # | Skill 文件 | 当前格式 | 新格式 | 动作 |
|---|-----------|----------|--------|------|
| 1 | `issue-tracker-local.md` | "Conventions" 段：`Status:` 行记录 triage state；`Type:` 行记录 ticket type；`Blocked by: NN, NN` 行 | YAML front matter（`id/title/map/type/status/triage/blocked_by/timestamps`）；body 只留自由文本段 | 重写 |
| 2 | `issue-tracker-local.md` | "Wayfinding operations" 段：Claim=set `Status: claimed`；Resolve=append `## Answer` + set `Status: resolved` + append decision pointer；Frontier=scan issues/ | 引用 CLI：Claim=`tracker ticket status --set claimed`；Resolve=`tracker ticket status --map <slug> --id <N> --set resolved`（agent 先填 `## Answer` + 追加 map.md decision pointer，thin CRUD G-Q15）；Frontier=`tracker query frontier --map <slug>` | 重写 |
| 3 | `issue-tracker-local.md` | "When a skill says publish/fetch" 段："Create a new file" / "Read the file" | publish=`tracker ticket create`；fetch=读文件（不变）或 `tracker ticket list` | 更新 |
| 4 | `issue-tracker-local.md` | 无 "实现操作" 段 | 新增 "实现操作" 段：local ticket commit convention `Resolves <map>/#<N>`（G7 决策——commit convention 放 tracker doc，不放 implement/SKILL.md） | 新增段落 |
| 5 | `issue-tracker-local.md` | 无 body 模板定义 | 新增 body 段模板定义（G4 决策——CLI 不管模板，模板在此定义）。**完整段列表**：task=`## What to build` + `## Acceptance criteria` + `## Out of scope`（可选）+ `## Testing`（可选）；research/grilling/prototype=`## Question`。to-spec 产出的 spec ticket（type=task 但用 to-spec 模板）：`## Problem Statement` + `## Solution` + `## User Stories` + `## Implementation Decisions` + `## Testing Decisions` + `## Out of Scope` + `## Further Notes`（to-spec SKILL.md 定义，不变）。所有 type 共有：`## Answer`（CLI 预置）+ `## Comments`（CLI 预置）。 | 新增段落 |
| 6 | `to-tickets/SKILL.md` | `<local-ticket-template>`：`**What to build:**` / `**Blocked by:**` / `**Status:**` 文本行 | YAML front matter + body 段引用 issue-tracker-local.md 模板。**注意：只改 `<local-ticket-template>`，`<issue-template>`（GitHub/GitLab 用）不变** | 重写 local 模板 |
| 7 | `to-tickets/SKILL.md` | "Publish to the configured tracker" → "Local files → write one file per ticket" | "Local files → run `tracker ticket create` for each ticket" | 更新 |
| 8 | `to-tickets/SKILL.md` | "Apply the `ready-for-agent` triage label unless instructed otherwise" | **行为变更**（数据模型驱动的修正，非 skill 业务逻辑变更）：wayfinder/to-tickets 产生的 ticket 不填 triage 字段（值为 null）。`ready-for-agent` triage 用于外部 inbound issue **和 to-spec 产出的 spec ticket**（见 item 18），不用于 wayfinder/to-tickets ticket。 | 更新 |
| 9 | `wayfinder/SKILL.md` | Map body 模板无 front matter | Map body 模板增加 front matter 示例（`title/state/milestone/created_at/closed_at`） | 更新 |
| 10 | `wayfinder/SKILL.md` | "Work through the map" → Claim/Resolve 用文本行操作 | 引用 CLI 命令（`tracker ticket status --set claimed` / `tracker ticket status --set resolved`）。**注意语义**：wayfinder 说 "assign it to yourself"，local CLI 用 `status --set claimed`（无 assignee 字段，claimed 状态即 claim） | 更新 |
| 11 | `triage/SKILL.md` | 基于 label 的 triage（GitHub/GitLab）；无 local tracker 路径 | 增加 local tracker 路径：triage 操作 = 读写 ticket front matter 的 `triage:` 字段（`tracker ticket triage --set <role>`）。**wontfix 仍是 triage role**，local 中 wontfix = `tracker ticket triage --set wontfix`（不是 status 变更）。triage Roles 段保持 5 个 roles 不变。**triage category（bug/enhancement）是 GitHub/GitLab-only**——local ticket 只有 state roles（triage 字段），无 category 字段。triage skill 的“每个 issue 必须有且仅有一个 category role 和一个 state role”规则只适用于 GitHub/GitLab；local ticket 只要求 state role（可选）。 | 新增段落 |
| 12 | `setup-matt-pocock-skills/SKILL.md` | 种子模板 `issue-tracker-local.md` 用旧格式 | 种子模板匹配新 YAML front matter 格式 | 更新种子 |
| 13 | `setup-matt-pocock-skills/SKILL.md` | Section B 文本说 "five canonical roles" | **不变**——triage 仍保持 5 个 roles（含 wontfix），wontfix 未被移除 | 无需改动 |
| 14 | `setup-matt-pocock-skills/SKILL.md` | 种子模板 `triage-labels.md` 定义 5 个 state roles | **不变**——5 个 roles 保持不变 | 无需改动 |
| 15 | `implement/SKILL.md` | 无 tracker-specific 内容 | **不在此文件增加 commit convention**（G7 决策）。implement/SKILL.md 保持通用，commit convention 见各 tracker doc 的 "实现操作" 段。如果 implement/SKILL.md 需要更新，只加一句"commit convention 见 tracker config" | 通用引用 |
| 16 | `CONTEXT.md` | `Destination._Avoid_: goal, objective, milestone` | 从 avoid 列表移除 `milestone`；新增 `Milestone` 术语定义 + `Progress` 术语定义 | 更新 |
| 17 | `to-epic/SKILL.md` + `setup-to-epic/SKILL.md` | 使用 `.scratch/<milestone>/<feature>/` 目录结构 | 无需改动——to-epic 的 milestone 与本设计的 Milestone 共存（见"术语调和"） | 无需改动 |
| 18 | `to-spec/SKILL.md` | 产出 spec issue（label `ready-for-agent`），模板用 `## Problem Statement` 等段 | **需更新 local publish 路径**（R3-Q1）：to-spec 在 local tracker 中调用 `tracker ticket create --map <slug> --title "Spec: ..." --type task --triage ready-for-agent` 创建 ticket（拿到 front matter + 骨架），然后用 bash/edit 填充 body（to-spec 自己的模板：Problem Statement / Solution / Implementation Decisions 等）。**to-spec ticket 保留 `triage: ready-for-agent`**——与 wayfinder/to-tickets ticket（triage=null）不同，to-spec 产出的 spec 是 agent-grabbable by construction。to-spec 的 body 模板不变。 | 更新 local publish 路径 |

## Agent 直接 bash 操作（skill 指导，不需要 CLI）

```bash
mkdir -p .scratch/<map-slug>/issues/           # 创建 Map 目录
# 写 map.md（含 front matter + Destination/Notes/...）   # skill 管内容
# 写 .scratch/.milestones/<slug>.md（含 front matter + description）  # skill 管内容
cat .scratch/<map>/issues/03-foo.md            # 读 ticket
# 编辑 ticket body（What to build / Question / Acceptance criteria）  # skill 管内容，模板见 issue-tracker-local.md
# 追加 comment 到 ## Comments 段                            # skill 管内容
# 更新 map 的 Destination/Notes/Fog/Out-of-scope            # skill 管内容
```
