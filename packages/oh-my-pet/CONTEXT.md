# Agent Pet

一只栖息在你代码库中的数字宠物伴侣，从你的 AI Agent 使用行为（token 消耗、终端命令）中成长，在状态栏中带来一点趣味——且绝不干扰实际开发。

## 术语表

**Pet (宠物)**:
与一个 Git 仓库绑定的数字伴侣。每个项目一只宠物，在所有 AI Agent 会话（pi、Claude Code 等）和所有贡献者之间共享。
_避免使用_: Agent、bot、character

**Pet Framework (宠物框架)**:
与 Agent 无关的核心运行时。加载 mod、管理 binlog、聚合属性、生成快照。以 `@pi-pets/core` 发布。
_避免使用_: Engine（太像游戏）、runtime（太通用）

**Pet Mod (宠物模组)**:
一个注册属性效果、将 Adaptor 层的原始事件转换为属性贡献的插件。遵循与 pi 扩展相同的注册模式：`export default function(pet: PetAPI)`。内置喂养逻辑与第三方 mod 无差别。
_避免使用_: Plugin、extension、addon

**Adaptor Layer (适配层)**:
每个 AI Agent 框架（pi、Claude Code、VS Code）对应的 Agent 特定代码。将各 Agent 的原生事件转换为 core-framework 消费的统一事件格式。同时负责将框架产出的状态栏字符串数组渲染到平台特定接口（pi 的 `setStatus()`、Claude Code 的 shell echo）。适配层不包含格式化逻辑——字符串由 Core Widget 引擎产出。
_避免使用_: Bridge、connector、driver

**Binlog**:
按会话划分的追加式日志文件，记录属性增量条目。当 mod 推送结果时由框架写入（非 Adaptor 层）。使用按会话的序列号排序，不依赖系统时钟。使同一项目上的多个 Agent 会话能够无锁并发写入。
_避免使用_: Event log、journal、WAL

**Binlog Entry (binlog 条目)**:
单条 binlog 记录的数据结构。字段：`sessionId`（所属会话）、`seq`（会话内单调递增序列号）、`responseId`（幂等键——单次 LLM 响应对应一条条目）、`timestamp`（写入时间）、`mod`（产生此条目的 mod 名称）、`attributes`（属性增量映射，键使用点分命名空间如 `core.exp`）。重放时同名键的贡献值按加和聚合。
_避免使用_: Record、log line、event

**Data Store Layer (数据存储层)**:
PetStore 接口定义的持久化抽象层。重放引擎通过此接缝读写快照和 binlog 条目，不接触文件系统。具体适配器（JSON 文件、SQLite、内存）实现 PetStore 接口。consumed 过滤和更新逻辑不在此层——它们归属于重放引擎。
_避免使用_: Repository、DAO、storage service

**Checkpoint (快照)**:
宠物 clamped 属性快照加上 `consumed` 映射（`sessionId → lastSeq`）。由 `/compact` 触发（搭载在 Agent 的上下文压缩流程上）。作为重放的起点——重放仅处理 seq > consumed 位置的 binlog 条目，然后钳制结果。
_避免使用_: Snapshot、save state

**Replay (重放)**:
重建当前宠物属性的确定性过程：从最新快照开始，应用每个会话中所有未被消费的 binlog 条目，并在每一步将各属性钳制到其注册的 `[min, max]` 范围内。属性贡献可加且可交换，因此跨会话的重放顺序无关紧要。
_避免使用_: Rebuild、recalculate

**Pet Attribute (属性)**:
由 mod 通过 `pet.registerEffect(name, policy)` 声明的命名数值，附带取值策略。属性键采用点分命名空间约定——前缀表示分类（`core.*` 生存属性、`ability.*` 能力维度、`equipment.*` 装备注入），框架仅做字符串匹配，不解析语义。core-framework 汇总所有 mod 的贡献，并在重放期间根据策略钳制。MVP 属性：`core.exp`（等级成长）、`core.fullness`（上下文使用百分比）、`core.vitality`（token 速度）。
_避免使用_: Stat、property、field

**Attribute Policy (属性策略)**:
定义属性合法取值范围的规则结构。MVP 阶段仅实现 `{min, max}` 基础策略——超出边界的值钳制到最近边界。Growth 阶段引入完整策略模型，借鉴 K8s resourceSlice capacity policy 设计：`validRange`（连续范围，含 min/max/step/default）和 `validValues`（离散合法值集合）二选一，钳制时向上取整而非简单截断。策略由属性注册时声明，重放引擎在执行钳制时读取。
_避免使用_: Constraint、validation rule

**PetAPI**:
core-framework 通过 `export default function(pet: PetAPI)` 注入到每个宠物 mod 的接口。仿照 pi 的 `ExtensionAPI` 模式——一个类型化 API 对象，包含 `registerEffect()`、`pushAttributes()` 和用于订阅统一事件的 `on()` 等方法。类型包 `@pi-pets/framework-api` 仅导出类型，不导出实例。
_避免使用_: SDK、plugin API

**PetAPI 生命周期（Lifecycle）**:
Mod 加载经历两个严格阶段，以框架调用 `seal()` 为分界：

1. **声明阶段（Declaration Phase）**：仅允许 `registerEffect(name, policy)`。Mod 声明其管理的属性及取值策略。`on()` 和 `pushAttributes()` 在此阶段不可用。
2. **运行阶段（Runtime Phase）**：`seal()` 后，注册表冻结。Mod 通过 `on(event, handler)` 订阅统一事件，通过 `pushAttributes(delta)` 推送属性增量。对未注册键的推送被拒绝。`registerEffect()` 不可用。

_避免使用_: init / boot / setup（用于声明阶段）；start / run（用于运行阶段）

**Session (会话)**:
单个 Agent 对话会话（例如一个 pi 会话、一个 Claude Code 会话）。每个会话有 Agent 分配的唯一 session-id，并写入自己的 binlog 文件。会话结束时，其 binlog 条目被完全消费，文件可被清理。
_避免使用_: Process、instance、connection

**Response (响应)**:
会话中的单次 LLM 请求-响应对。每个响应有 Agent 分配的唯一 response-id，在 binlog 条目中用作幂等键。
_避免使用_: Turn、exchange、call

**Dashboard (面板)**:
通过 `/pet` 命令触发的简单文本显示。展示当前项目中宠物的属性、等级和近期喂食历史。MVP 中无 TUI 组件。
_避免使用_: UI、panel、GUI

**Phase (阶段)**:
宠物项目的生命周期阶段：MVP（带 binlog + 面板的喂养 mod，完整 PetAPI 架构）、Growth（装备、技能、能力维度）、Social（多人、战斗）。
_避免使用_: Milestone、version、release

**Attribute Namespace (属性命名空间)**:
属性键的点分前缀约定，指明属性所属分类。MVP 使用 `core.*`（生存属性），Growth 预留 `ability.*`（能力维度）、`equipment.*`（装备属性）。框架不解析点分结构——仅做字符串匹配。面板可按前缀分组。
_避免使用_: Category、group、type

**Status Line Widget (状态栏组件)**:
状态栏中的一个可渲染单元，将 PetState 映射为一段格式化字符串。每个 Widget 有唯一标识（如 `speciesIcon`、`fullnessBar`）和所属分类。Core 提供默认 Widget 集，Mod 可通过 `pet.registerWidget()` 注入新 Widget。Widget 返回 `null` 表示当前不可见（如非 git 项目隐藏 git widget）。
_避免使用_: Component、element、segment

**Status Line Config (状态栏配置)**:
定义状态栏布局——行数、每行的 Widget 列表、每个 Widget 的配置覆盖。存储在 `.pet/statusline.json`（项目级）或 `~/.config/agent-pet/statusline.json`（全局默认）。MVP 默认单行：`[speciesIcon, level, fullnessBar, vitality]`。
_避免使用_: Layout、template

## 标记的歧义点

- **"Agent"** 一词有多重含义。当指 pi、Claude Code 等时，使用 **AI Agent** 或 **Agent Framework**。当指宠物时，使用 **Pet**。不要将任何一方缩写为仅 "agent"。
- **"Level"** 在 PRD 文档中有时指宠物成长等级（Lv.3），有时指装备升级等级（Lv.4）。区分为 **Pet Level（宠物等级）** 和 **Equipment Level（装备等级）**。

## 示例对话

> **开发者 A**: "我刚发了一个超大的 prompt，宠物的饱腹度飙升到了 98%。喂养 mod 把 `{fullness: +45}` 推送到了 binlog。"
>
> **开发者 B**: "是啊，我的也是——我在这个项目上同时用 pi 和 Claude Code。两个会话各自写入自己的 binlog 文件，没有冲突。framework 重放了两个文件并求了和。"
>
> **开发者 A**: "饱腹度到 100 会怎样？"
>
> **开发者 B**: "在重放时钳制。binlog 仍然记录原始的 +45 意图，但快照会显示 100。如果我切换分支，上下文缩小，饱腹度自然会回落到 100 以下。"
>
> **开发者 A**: "有道理。快照是自动触发的吗？"
>
> **开发者 B**: "搭载在 /compact 上。当 Agent 压缩上下文时，Adaptor 层告诉 framework 生成新快照并更新 consumed 映射。"
