# Skill Presets

将 pi skills 组织为命名的 preset 分组，session 启动时只加载默认 preset，按需动态加载/卸载其他 preset，同时保持 prefix cache 命中率。

## Language

**Preset**:
一组 skills 的命名集合，作为一个整体被加载或卸载。
_Avoid_: group, bundle, pack

**Skill**:
一个 pi skill 目录（含 `SKILL.md`），可被 pi 原生机制或本包的 context 注入机制加载到 LLM 上下文中。
_Avoid_: capability, ability

**Transient injection**:
通过 `context` 事件在每个 provider request 前临时注入 skill 内容到消息数组末尾。不持久化到 session 文件，每轮重新注入。本包的核心注入机制。
_Avoid_: message injection, context stuffing

**Persistent entry**:
通过 `appendEntry(customType, data)` 写入 session 文件的状态记录。类型为 `"custom"`，不发送给 LLM，用于跨 session 恢复 preset 状态。
_Avoid_: log, history record

**Load**:
激活一个 preset ——将其名称加入 active set，并写入一条 persistent entry 记录此操作。
_Avoid_: enable, activate, apply

**Offload**:
停用一个 preset ——将其名称从 active set 中移除，并写入一条 persistent entry 记录此操作。LLM 历史中仍有之前轮次注入的 skill 内容，但不再刷新。
_Avoid_: disable, deactivate, remove

**Active set**:
当前已 load 且未 offload 的 **preset 名称集合**（`Set<string>`）。每轮 context 事件时，从 active set 中的 preset 名称动态解析出 skills 列表（合并去重），再注入。Skills 不持久化在 active set 中——它们是每轮从 preset 定义临时解析的。
_Avoid_: loaded skills, current preset, skills collection

**Default preset**:
始终通过 `settings.skills` 加载到 system prompt 的 preset。所有 session 都加载，由 pi 原生机制管理。不使用 transient injection。包在 `session_start` 时自动将 default preset 的 skills 写入 `settings.skills`（用 `+` 前缀），尊重已有的 `-` 前缀（不覆盖用户禁用）。
_Avoid_: base preset, always-on preset

**Non-default preset**:
通过 transient injection 加载的 preset。状态记录在 session 级别的 persistent entries 中。同一 session 重启后，之前 load 的 non-default preset 自动恢复（从 persistent entries 重建），除非用户显式 offload。
_Avoid_: dynamic preset, optional preset

**Prefix cache**:
LLM provider 对请求前缀（system prompt + 前面的 messages）的缓存。Transient injection 在数组末尾追加，不破坏已有前缀的缓存。
_Avoid_: prompt cache, KV cache

**Compaction recovery**:
pi 的 compaction 会摘要并丢弃消息数组中的内容。Transient injection 因每轮重新注入而天然免疫 compaction。但 persistent entries 中的状态需要从 entries 重建。
_Avoid_: compaction survival, message recovery

**Skill-manager toggle**:
`@vanillagreen/pi-skills-manager` 通过 `settings.skills` 中的 `+`/`-` 前缀模式禁用/启用 skill。本包在 load preset 时必须尊重这些禁用模式，不重新启用被用户禁用的 skill。
_Avoid_: skill enablement, skill switch

## Relationships

- **Preset → Skill**: 一个 preset 包含多个 skill 引用（按名称或路径）。
- **Active set → Preset**: Active set 是 preset 名称的集合。每轮从 active set 中的 preset 名称解析出 skills（合并去重），自然处理跨 preset 的 skill 重叠——无需引用计数。
- **Persistent entry → Load/Offload**: 每次 load/offload 操作都写入一条 persistent entry，记录操作类型（`action: 'load' | 'offload'`）、preset 名称、时间戳。
- **Default preset → System prompt**: Default preset 的 skills 通过 settings.skills 加载到 system prompt。Default preset **不在** active set 中。
- **Non-default preset → Active set**: Non-default preset 通过 transient injection 加载——preset 名称加入 active set，每轮从 preset 定义解析 skills 注入。
- **Transient injection → Active set**: 每轮 context 事件时，从 active set 中的 preset 名称动态解析出 skills 列表（合并去重），排除已在 system prompt 中的 default preset skills（避免跨上下文重复），用 `formatSkillsForPrompt` 格式化为一条 CustomMessage 追加到消息数组末尾。
- **Session restart → Persistent entries**: 同一 session 重启后，从 persistent entries 重建 active set。之前 load 的 non-default preset 自动恢复，除非已显式 offload。
- **Skill-manager toggle → Active set**: Active set 中的 skills 必须排除被 skill-manager toggle 禁用的 skills。
