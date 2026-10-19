# Skill Presets

将 pi skills 组织为命名的 preset 分组，session 启动时只加载默认 preset，按需动态加载/卸载其他 preset，同时保持 prefix cache 命中率。

## Language

**Preset**:
一组 skills 的命名集合，作为一个整体被加载或卸载。
_Avoid_: group, bundle, pack

**Skill**:
一个 pi skill 目录（含 `SKILL.md`），可被 pi 原生机制或本包的注入机制加载到 LLM 上下文中。
_Avoid_: capability, ability

**System prompt filtering**:
通过 `before_agent_start` 事件过滤系统提示词中 `<available_skills>` 部分的过程。只在 session_start 或 reload 后的首次 `before_agent_start` 时执行，用 `needsFilter` 标记控制。过滤后系统提示词只包含 active set 中的技能。
_Avoid_: prompt rewriting, system prompt modification

**Transient injection**:
通过 `context` 事件在每个 provider request 前临时注入 skill 内容到消息数组末尾。不持久化到 session 文件，每轮重新注入。用于 session 中途加载的 non-default preset 的技能。
_Avoid_: message injection, context stuffing

**Persistent entry**:
通过 `appendEntry(customType, data)` 写入 session 文件的状态记录。类型为 `"custom"`，不发送给 LLM，用于跨 session 恢复 preset 状态。
_Avoid_: log, history record

**Load**:
激活一个 preset ——将其名称加入 active set，并写入一条 persistent entry 记录此操作。
_Avoid_: enable, activate, apply

**Offload**:
停用一个 preset ——将其名称从 active set 中移除，并写入一条 persistent entry 记录此操作。
_Avoid_: disable, deactivate, remove

**Active set**:
当前已 load 且未 offload 的 **preset 名称集合**（`Set<string>`）。包含 default preset（始终在内）。Session start / reload 时从 persistent entries 重建。`before_agent_start` 过滤和 transient injection 都从 active set 解析技能。
_Avoid_: loaded skills, current preset, skills collection

**Default preset**:
始终在 active set 中的 preset。session_start 时自动加入 active set。其技能通过 system prompt filtering 进入系统提示词的 available_skills，与其他 active set 中的 preset 技能一同过滤。不使用 `settings.skills` 写入。
_Avoid_: base preset, always-on preset

**Non-default preset**:
用户按需 load 的 preset。在 session 中途 load 时，其技能通过 transient injection 注入。在 session start / reload 时，如果该 preset 在 persistent entries 中记录为已 load 且未 offload，则其技能通过 system prompt filtering 进入系统提示词。
_Avoid_: dynamic preset, optional preset

**needsFilter flag**:
布尔标记，控制 `before_agent_start` 是否执行 system prompt filtering。`session_start` 事件将其设为 `true`，`before_agent_start` 首次执行后设为 `false`。确保 system prompt 只在 session/reload 边界变化，session 中途保持稳定以保护 KV cache。
_Avoid_: filter trigger, prompt dirty flag

**Prefix cache**:
LLM provider 对请求前缀（system prompt + 前面的 messages）的缓存。System prompt filtering 只在 session_start/reload 后执行一次；transient injection 在数组末尾追加，不破坏已有前缀的缓存。
_Avoid_: prompt cache, KV cache

**Compaction recovery**:
pi 的 compaction 会摘要并丢弃消息数组中的内容。Transient injection 因每轮重新注入而天然免疫 compaction。Persistent entries 中的状态从 entries 重建。
_Avoid_: compaction survival, message recovery

**Skill-manager toggle**:
`@vanillagreen/pi-skills-manager` 通过 `settings.skills` 中的 `+`/`-` 前缀模式禁用/启用 skill。本包在 system prompt filtering 和 transient injection 时读取 `-` 模式，排除被禁用的 skill。本包不写入 `settings.skills`。
_Avoid_: skill enablement, skill switch

## Relationships

- **Preset → Skill**: 一个 preset 包含多个 skill 引用（按名称）。
- **Active set → Preset**: Active set 是 preset 名称的集合，包含 default preset。Session start / reload 时从 persistent entries 重建。
- **Persistent entry → Load/Offload**: 每次 load/offload 操作都写入一条 persistent entry，记录操作类型（`action: 'load' | 'offload'`）、preset 名称、时间戳。
- **Session start → Active set + needsFilter**: `session_start` 事件触发：清空 active set → 加入 default preset → 从 persistent entries 回放 load/offload → 设 `needsFilter = true`。
- **before_agent_start → System prompt filtering**: `before_agent_start` 事件检查 `needsFilter`：为 `true` 时，从 `event.systemPromptOptions.skills` 过滤出 active set 中的技能，用 `formatSkillsForPrompt` 重建 `<available_skills>` 段落，替换 system prompt 中的对应部分，返回修改后的 `systemPrompt`，设 `needsFilter = false`。为 `false` 时返回 `undefined`，pi 使用未修改的 `_baseSystemPrompt`。
- **context event → Transient injection**: `context` 事件每轮触发：从 active set 解析全部技能名称，排除已在 system prompt 中的技能（由 `before_agent_start` 过滤时记录），将剩余技能用 `formatSkillsForPrompt` 格式化为 CustomMessage 追加到消息数组末尾。
- **Mid-session load → Transient injection**: `/preset-load` 在 session 中途执行时：加入 active set + 写 persistent entry + `needsFilter` 保持 `false`。新技能通过 context 事件注入，system prompt 不变，KV cache 保持。
- **Reload → System prompt filtering**: `/reload` 触发 `session_start`（reason: "reload"）→ 重建 active set + `needsFilter = true` → 下一条消息的 `before_agent_start` 执行过滤（含所有已加载 preset 的技能）。
- **Skill-manager toggle → Filtering**: System prompt filtering 和 transient injection 都读取 `settings.skills` 中的 `-` 模式，排除被 skill-manager 禁用的 skill。本包不写入 `settings.skills`。
