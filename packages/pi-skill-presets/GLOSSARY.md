# Skill Presets

将 pi skills 组织为命名的 preset 分组。`before_agent_start` 每轮把 pi 发现的技能列表无状态地收敛为 allowed 并集的子集并写回，由 pi 原生渲染 section diff，保持 prefix cache 命中率。

v3 设计记录见 spec [peachest/pi-packages#40](https://github.com/peachest/pi-packages/issues/40)；平台行为证据见 map issue #32 Notes。

## Language

**Preset**:
一组 skills 的命名集合，作为一个整体被 load 或 offload。
_Avoid_: group, bundle, pack

**Skill**:
一个 pi skill 目录（含 `SKILL.md`），由 pi 原生发现机制加载。本包只决定哪些技能留在 `systemPromptOptions.skills` 中，不注入技能内容。
_Avoid_: capability, ability

**Active set**:
当前已 load 且未 offload 的 **preset 名称集合**（`Set<string>`）。default preset 始终在内。session_start / session_tree 时从当前 leaf 路径的 persistent entries 路径感知回放重建。
_Avoid_: loaded skills, current preset, skills collection

**Allowed 并集**:
default preset 的技能 ∪ active set 中其他 preset 的技能，去重后的技能名称集合。`before_agent_start` 变异的收敛目标：最终列表是该并集与 pi 已发现技能的交集。
_Avoid_: filter list, whitelist

**每轮无状态变异**:
`before_agent_start` 每轮重新读 presets 配置、按当前 active set 解析 allowed 并集，与 `event.systemPromptOptions.skills`（pi 已发现的技能）按名称求交集、按 pi 发现顺序去重后写回，返回 `undefined`。无跨轮缓存、无一次性 flag，同一输入下每轮结果相同。
_Avoid_: one-shot filtering, prompt dirty flag

**零配置直通**:
未配置 presets 且 active set 为空时，`before_agent_start` 返回 `undefined`，完全不触碰 pi 发现的技能列表。
_Avoid_: empty passthrough, no-op filter

**Persistent entry**:
通过 `appendEntry(customType, data)` 写入 session 文件的状态记录。类型为 `"custom"`（customType `preset-op`），不发送给 LLM，用于跨 session / 跨树导航恢复 active set。
_Avoid_: log, history record

**Load**:
激活一个 preset —— 将其名称加入 active set，并写入一条 persistent entry。下一轮 `before_agent_start` 变异即生效。
_Avoid_: enable, activate, apply

**Offload**:
停用一个 preset —— 将其名称从 active set 中移除，并写入一条 persistent entry。default preset 不可 offload。
_Avoid_: disable, deactivate, remove

**Default preset**:
始终在 active set 中的 preset，路径感知回放时自动加入。其技能经 allowed 并集进入 `systemPromptOptions.skills`。本包不写 `settings.skills`。
_Avoid_: base preset, always-on preset

**路径感知回放**:
恢复 active set 时用 `sessionManager.buildContextEntries()` 从当前 leaf 沿 session 树遍历收集 preset-op entries——被放弃分支上的 load/offload 不参与回放。compaction 感知；对线性 session 等价于全量 entries。
_Avoid_: full replay, linear replay

**session_tree 导航重建**:
树导航（切换 branch / leaf）触发 `session_tree` 事件 → 重新执行路径感知回放 → active set 反映新路径上的 preset 操作历史，下一轮变异即生效。
_Avoid_: tree reload, branch switch

**命令失败可见性分级**:
命令失败按原因分级呈现：load 未知名（不在 `definitions`）→ `error` notify，不写 entry；preset 内含坏引用（missing 或 disabled 技能）→ `warning` notify 但照常 load；offload default preset → `error` 拒绝；`/preset-status` 对配置缺失（missing from config）的 preset 做标注。
_Avoid_: silent failure, uniform error

**Prefix cache**:
LLM provider 对请求前缀（system prompt + 前面的 messages）的缓存。本包每轮只做 skills 数组的子集收敛并返回 `undefined`，system prompt 与消息数组结构由 pi 原生 section diff/patch 维护，前缀不被破坏。
_Avoid_: prompt cache, KV cache

## Relationships

- **Preset → Skill**: 一个 preset 包含多个 skill 引用（按名称）。
- **Active set → Preset**: Active set 是 preset 名称的集合，包含 default preset。session_start / session_tree 时从当前 leaf 路径的 persistent entries 路径感知回放重建。
- **Persistent entry → Load/Offload**: 每次 load/offload 都写入一条 persistent entry（customType `preset-op`），记录操作类型（`action: 'load' | 'offload'`）、preset 名称、时间戳。
- **session_start / session_tree → 路径感知回放 → Active set**: 两个事件共用同一重建逻辑：清空 active set → 加入 default preset → `buildContextEntries()` 从当前 leaf 遍历收集 entries → 按时间顺序回放 load/offload。
- **before_agent_start → 每轮无状态变异 → pi 原生 section diff/patch**: `before_agent_start` 每轮读配置 → 解析 allowed 并集 → 与 `event.systemPromptOptions.skills` 求交集并按 pi 发现顺序去重 → 写回 `event.systemPromptOptions.skills` → 返回 `undefined`，由 pi 对 skills section 做原生 diff/patch 渲染。零配置时直通（返回 `undefined`，不写回）。
- **坏引用 → warning 而非阻塞**: preset 引用了 pi 未发现的技能（missing 或被 skill-manager disable）不阻塞 load；session_start / session_tree 回放后首个变异轮统一 warning 一次，显式 load 动作当场 warning。
- **本包 ↔ settings.json / skill-manager 边界**: 本包不写 `settings.skills`，也读不到 skill-manager 内部状态；被 skill-manager disable 的技能不在 pi 的发现结果中，天然被交集剔除，只体现为坏引用 warning。
- **Compaction / 树导航 → 路径感知回放**: compaction 与树导航不破坏恢复正确性——`buildContextEntries()` 从当前 leaf 遍历，只回放当前路径上的 entries。
