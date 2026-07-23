# pi-thefuck — 领域词汇表

## 核心概念

**Fuck (撤销)**:
将最近一次失败的 tool call 从 LLM 上下文中移除，触发 agent 自动重试。类比原版 thefuck 的"失败一个修正一个"哲学。不修改 session JSONL 文件，仅在 context 事件中过滤。
_避免使用_: undo、revert、rollback

**Failed Tool Call (失败的工具调用)**:
`isError === true` 的 toolResult 所对应的 toolCall。由 LLM 生成的 bash 命令执行错误、read 对目录操作等场景触发。
_避免使用_: error call、bad call

**Context Filtering (上下文过滤)**:
在 pi 的 `context` 事件中，从发送给 LLM 的消息数组中移除被 fuck 的 toolCall 及其 toolResult。过滤仅影响 LLM 看到的上下文，不触碰磁盘上的 JSONL。
_避免使用_: message deletion、session mutation

**Batch Scope (批次范围)**:
`/fuck` 只在最近一次 assistant 消息对应的 toolCall 批次内查找失败。不跨回合回溯——如果最新回复全部成功，本回合无需修正。
_避免使用_: global lookup、full scan

## 关键行为

**Sibling-safe (保留并行成功调用)**:
同一 assistant 消息中，未被 fuck 的 toolCall 及其成功的 toolResult 保持不动。只移除被 fuck 的那一个。
_避免使用_: batch cancel、all-or-nothing

**Idempotent (幂等)**:
对同一个 toolCallId 重复 `/fuck` 不会产生副作用，第二次及以后为 no-op。
_避免使用_: redo-safe、repeat-safe

**Invisible Continue (隐式继续)**:
fuck 完成后通过 `pi.sendMessage({ display: false }, { triggerTurn: true })` 自动触发 agent 重试。消息不进入 TUI 展示。
_避免使用_: auto-retry、silent continue

**Double-tap Shortcut (双击快捷键)**:
空输入状态下 300ms 内按两次 `f`，等效于 `/fuck` 命令。使用 `ctx.ui.onTerminalInput()` 实现，与 pi-bump 的双击 Enter 模式一致。
_避免使用_: hotkey、key binding

**parentId Chain (父链)**:
toolResult 的 `parentId` 不直接指向 assistant，而是串联在前一个 toolResult 之后。这对 `/fuck` 无影响——过滤发生在 context 数组而非 JSONL，不参与 parentId 追踪。
_避免使用_: message tree、branch chain
