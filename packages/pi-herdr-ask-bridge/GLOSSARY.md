# pi-herdr-ask-bridge

将 `ask_user_question` 的 blocked 信号桥接到 Herdr，使 pane 图标在 agent 等待用户回答时切换为 blocked 态。

## Domain

**Event bridging** — pi 扩展间通过共享的 `pi.events` 总线通信。`@juicesharp/rpiv-ask-user-question` emit `rpiv:ask-user:blocked`；Herdr 的 pi 集成（`herdr-agent-state.ts`）监听 `herdr:blocked`。两者命名空间不同，没有默认桥接。

## Why

用户观察：agent 调用 `ask_user_question` 时，Herdr pane 图标不变（仍是 working），无法和普通 agent loop 区分。根因不在 Herdr 侧（Herdr 已有 blocked glyph），也不在 rpiv 侧（rpiv 已 emit blocked 事件），而在两者之间缺一座桥。

## Vocabulary

- **rpiv:ask-user:prompt** — 问卷打开前 emit，携带问题元数据（header、question、options）。
- **rpiv:ask-user:blocked** — `{ active: true }` 问卷显示中（等待用户），`{ active: false }` 问卷关闭（回答/取消/错误）。rpiv 用 try/finally 保证配对。
- **herdr:blocked** — `{ active: true, label }` / `{ active: false }`。herdr-agent-state.ts 用计数模型（blockedCount++/--）消费，支持多个 emit 源叠加。

## Decisions

- **桥接而非 hook tool_call。** rpiv 已在问卷生命周期内 emit 精确配对的 blocked 事件（try/finally 保证 active:true/false 平衡）。hook `tool_call`/`tool_result` 需要自己跟踪 toolCallId 和清理边界条件，重复造轮子且更脆弱。
- **label 取自 prompt 事件的 header。** `rpiv:ask-user:prompt` 在 `rpiv:ask-user:blocked { active: true }` 之前 emit，可先捕获 header 作为 label。header 是 ≤16 字符的 chip，比完整 question 文本更适合状态栏。
- **gate on HERDR_ENV。** 非 Herdr 环境下 rpiv 事件仍在 emit，但没有 herdr 监听者，emit 是无害的 no-op。但仍 gate 以跳过不必要的监听器注册。
- **不修改 herdr-agent-state.ts。** 该文件由 `herdr integration install pi` 管理，升级会被覆盖。桥接通过 `pi.events` 总线通信，是设计的扩展点。
