# pi-thefuck 设计文档

## 灵感来源

[thefuck](https://github.com/nvbn/thefuck) — 当终端命令执行失败时，输入 `fuck` 自动修正。

pi-thefuck 将同样的哲学带入 pi agent 语境：当 AI 生成的工具调用执行失败或用户中断时，输入 `/fuck` 取消最近失败的 tool call，让 agent 自动重试。

## 核心行为

> 像 thefuck 一样取消掉最近失败的 tool call。

### 数据模型 — 基于实际 session 分析

分析了一个真实的 pi-wishlist session（83 条 entry），确认了以下结构。

#### Tool call 在 JSONL 中的存储

一个 assistant 消息可以包含**多个并行**的 tool call：

```
entry cbec12f5 — assistant:
  text: "Let me check the project structure..."
  toolCall: bash(id=call_90f30ab, "ls issues/")
  toolCall: read(id=call_4a6f63e, "read issues/")
       │
       ├─ entry aba3103e — toolResult(bash,  isError=false)  ← 成功
       └─ entry c1dee769 — toolResult(read, isError=true)   ← 失败！
              content: "EISDIR: illegal operation on a directory, read"
```

#### parentId 链是线性的，不是树形的兄弟关系

```json
{
  "id": "cbec12f5", "parentId": "89c837ff",  // assistant
  "message": { "role": "assistant", "content": [{"type":"toolCall",...}, ...] }
}
{
  "id": "aba3103e", "parentId": "cbec12f5",  // toolResult#bash
  "message": { "role": "toolResult", "toolCallId": "call_90f30ab", "isError": false }
}
{
  "id": "c1dee769", "parentId": "aba3103e",  // toolResult#read
  "message": { "role": "toolResult", "toolCallId": "call_4a6f63e", "isError": true,
               "content": [{"text":"EISDIR: illegal operation on a directory, read"}] }
}
```

重点：toolResult 的 `parentId` **不直接指向 assistant**，而是指向上一个 toolResult。toolResult 之间通过 parentId 串联成链。

这对 `/fuck` 的影响：
- ✅ **context 过滤不影响 parentId 链** — 因为不动 JSONL，只在 context 数组中进行过滤
- 查找时需要按 parentId 回溯找到对应的 assistant entry

#### 失败的 toolResult entry 的完整字段

```json
{
  "type": "message",
  "id": "c1dee769",
  "parentId": "aba3103e",
  "timestamp": "2026-06-24T07:54:20.967Z",
  "message": {
    "role": "toolResult",
    "toolCallId": "call_4a6f63e77aaf450a92083b93",
    "toolName": "read",
    "content": [{"type": "text", "text": "EISDIR: illegal operation on a directory, read"}],
    "details": {},
    "isError": true,
    "timestamp": 1782287660966
  }
}
```

识别失败 tool call 的 key：`isError === true`

### `/fuck` 的核心流程

1. 从当前分支的 messages 中找到**最后一个包含 toolCall 的 assistant 消息**
2. 在该 assistant 消息对应的 toolResult 中，找到最后一个 `isError: true` 的
3. 若该批次内没有失败 → 停止，返回 "No failed tool calls to undo"
4. 若找到了 → 在 `context` 事件中，将该 toolCall + 对应 toolResult 从 LLM 上下文中过滤掉
5. 若该 assistant 消息的所有 toolCall 都被删了 → 移除整个 assistant 消息
6. 自动发送 "Continue" 信号触发 agent 重试

### 分支处理

```
User msg ─── Assistant(bash+read) ─── ToolResult(bash, ok) ─── ToolResult(read, fail)
                                          │                            │
                                          │                     /fuck 过滤掉这个
                                          │                            │
                                          ▼                            ▼
                                    LLM context 中只看到:
                                    User msg + Assistant(bash) + ToolResult(ok)
                                    → 自动 Continue 触发重试
```

## 触发方式

### 1. `/fuck` 命令

```
输入 /fuck
→ 立即生效，无二次确认（符合 thefuck 精神）
```

注册 `pi.registerCommand('fuck', ...)`

### 2. 双击 `f` 快捷键

参考 pi-bump 的双击 Enter，使用小写 `f`（`/fuck` 的首字母）：

- 空输入状态下，300ms 内按两次 `f`
- 等效于输入 `/fuck` 命令
- 与所有已有快捷键不冲突（`f` 没有被系统占用）
- 与 pi-bump 不冲突：pi-bump 用 Enter，pi-thefuck 用 `f`

**为什么不双击 Escape？** Escape 默认绑定 `app.interrupt`，无法通过 `registerShortcut` 覆盖。改用 `ctx.ui.onTerminalInput()` 监听 `f` 键，`data === "f" || data === "F"` 比较（和 wishlist 项目检测 `Y/y` 键的方式一致）。

## 实现方案

### 方案：context 事件过滤（选中）

把被 fuck 的 tool call 标记为"隐藏"，在 `context` 事件中将其从发送给 LLM 的消息列表中删除。

**为什么不是直接修改 JSONL？**
- JSONL 有树形结构（id/parentId），删除行会破坏分支
- context 过滤是 pi 扩展的推荐做法（pi-bump 也用同样模式：`__invisible_continue` 消息写在 JSONL 中但 `display: false`，context 替换为 "Continue"）
- 消息保留在 session 文件中用于复盘，只是 LLM 看不见

**这就是"标记为隐藏"的含义** — 实际 JSONL 不删，只从 context 构建中跳过。

### 扩展状态追踪

需要维护每个 session 中被 fuck 的 toolCallId 列表：

```typescript
// 内存状态（session 级别）
// key: sessionId, value: Set<被 fuck 的 toolCallId>
const fuckedToolCalls = new Map<string, Set<string>>()
```

### 查找逻辑

`/fuck` 命令只关注**最后一个 assistant 批次**内的失败：

```
function findLastFailedToolCall(messages: Message[]):
    // 1. 从尾到头，找到最后一个含有 toolCall 的 assistant 消息
    for i in reverse(messages):
        if messages[i].role === "assistant" && has toolCalls:
            // 记录这个批次中所有 toolCall 的 ID
            batchToolCallIds = set of toolCall ids
            break

    if no batchToolCallIds:
        return null

    // 2. 反向遍历，只检查属于这个批次的 toolResult
    for i in reverse(messages):
        if messages[i] is toolResult
           && messages[i].isError === true
           && messages[i].toolCallId in batchToolCallIds:
            return messages[i].toolCallId

    // 3. 该批次全部成功 → 不跨批次回溯
    return null
```

**为什么不全局查找？** 如果最新的 LLM 回复（一个 assistant 消息及其 toolResult）全部成功，说明没有需要修正的失败。跨多个 LLM 回合去找一个很早之前的失败，不符合用户的直觉——用户期望 `/fuck` 修正刚看到的错误。

### context 事件处理

```typescript
pi.on("context", (event) => {
  const messages = event.messages
  const sessionId = ctx.sessionManager.getSessionId()
  const fucked = fuckedToolCalls.get(sessionId)
  if (!fucked || fucked.size === 0) return

  // 先扫描，只在有需要修改时才分配新数组（性能优化，参考 pi-bump）
  const hasFucked = messages.some(msg => {
    if (msg.role === "toolResult" && fucked.has(msg.toolCallId)) return true
    if (msg.role === "assistant") {
      const calls = msg.content?.filter(c => c.type === "toolCall") ?? []
      return calls.some(c => fucked.has(c.id))
    }
    return false
  })
  if (!hasFucked) return

  const modified = messages.flatMap(msg => {
    // 1. 过滤掉被 fuck 的 toolResult
    if (msg.role === "toolResult" && fucked.has(msg.toolCallId)) return []

    // 2. 从 assistant 消息中移除被 fuck 的 toolCall
    if (msg.role === "assistant" && msg.content) {
      const filtered = msg.content.filter(block =>
        block.type !== "toolCall" || !fucked.has(block.id)
      )
      // 如果所有 toolCall 都被移除，assistant 就没意义了 -> 删掉
      if (filtered.length === 0) return []
      if (filtered.length !== msg.content.length) {
        return [{ ...msg, content: filtered }]
      }
    }
    return [msg]
  })

  return { messages: modified }
})
```

### 自动 Continue

与 pi-bump 类似，fuck 之后发送 invisible Continue 触发 agent 重试：

```typescript
pi.sendMessage({
  customType: "__invisible_continue",  // 复用 pi-bump 的格式，方便共存
  content: "Continue — the previous tool call was undone by /fuck",
  display: false,
}, { triggerTurn: true })
```

## 与 pi-bump 的共存

| 特性 | pi-bump | pi-thefuck |
|------|---------|------------|
| 快捷键 | 双击 Enter | 双击 Escape |
| 作用 | 让 agent 继续 | 撤销失败的工具调用后重试 |
| context 过滤 | 替换 customType 为 "Continue" | 移除被 fuck 的 toolCall + toolResult |
| 消息 | invisible "Continue" | invisible 过滤后 auto-continue |
| 场景 | agent 停住了，推一把 | agent 出了错，撤销后重来 |

同时安装两个扩展时，各管各的键，完全不冲突。甚至可以联动：用 pi-bump 继续，用 pi-thefuck 先撤销再继续。

## 边界情况

### 1. 没有失败的 tool call

`/fuck` 但当前分支上没有任何 `isError: true` 的 toolResult → 提示 "No failed tool calls to undo"。

### 2. tool call 还在执行中

用户按 Escape 中断了正在执行的 tool call（比如一个跑了 2 分钟的 ocr 命令），此时 session 中没有 isError 记录，但 tool execution 被中断了。

方案：处理 **用户输入 `/fuck` 时 agent 还在执行** 的情况。

### 3. 连续多个失败的 tool call

```
assistant: [toolCall A, toolCall B]
  ├─ ToolResult A (isError)
  └─ ToolResult B (isError)
```

两个失败在同一批次内。`/fuck` 一次只 fuck 最后一个（ToolResult B）。用户需要多次 `/fuck` 来逐个撤销。这符合 thefuck 的"一次修一个错误"的哲学。

### 4. 被 fuck 过的 tool call 再次 fuck

幂等：同一个 toolCallId 被记录后，再次 `/fuck` 会提示 "No more failed tool calls to undo"（因为已记录的不会被再次找到）。

### 5. 跨 session 状态

fuckedToolCalls 是内存状态。session 切换时在 `session_shutdown` 中清理。session 重启后，之前被 fuck 的 tool call 会再次可见（这是期望的行为——新 session 重新开始）。

## 配置选项

```typescript
const config = {
  doubleTapThresholdMs: 300,     // 双击 f 的阈值
  doubleTapKey: "f",             // 快捷键
}
```

## 项目文件结构

```
~/.pi/agent/extensions/pi-thefuck/
├── index.ts           # 主入口：命令注册 + context 过滤
├── package.json       # 依赖声明（如有需要）
└── DESIGN.md          # 本文档（只在项目目录）
```

## 可行性验证结果

使用 5 个独立 probe 在真实 pi 环境中验证了设计方案中的每一步。

### Probe 1: Session 遍历与 context 过滤 ✅

**文件**: `probes/01-traverse-and-filter.ts`

测试内容：
1. 解析真实 JSONL 文件（wishlist 项目的 83 条 entry）
2. 通过 `parentId` 链构建分支
3. **成功找到**真实的失败 tool call（`read` 对目录执行 EISDIR 错误）
4. 验证 toolCallId 能匹配回对应的 assistant message
5. 执行 context 过滤：移除了失败的 toolResult（`c1dee769`）和 assistant 中的对应 toolCall
6. **所有 sibling tool call 都被正确保留**（28 个 sibling 全部通过验证）

### Probe 2: 边界情况测试 ✅

**文件**: `probes/02-edge-cases.ts`

| 用例 | 结果 |
|------|------|
| 多个连续失败，只 fuck 最后一个 | ✅ ToolResult 正确移除，成功 toolResult 保留 |
| assistant 所有 toolCall 都失败 | ✅ 整个 assistant 被移除，只剩 user message |
| 没有失败 tool call | ✅ 消息序列不变（no-op） |
| 空 fucked set | ✅ 消息序列不变 |
| 重复 fuck（幂等） | ✅ 两次 fuck 结果一致 |
| 孤立 toolCallId（没有匹配的 assistant） | ✅ toolResult 被移除，assistant 带文本保留 |

### Probe 3: 扩展 API 编译验证 ✅

**文件**: `probes/03-extension-api-test.ts`

验证了以下 API 全部可以正确编译：
- `ExtensionAPI`, `ExtensionCommandContext` 类型
- `Key` enum 和 `matchesKey()`（用于双击 Escape 检测）
- `Type` from typebox（tool 参数定义）
- `registerCommand`, `on('context')`, `on('session_start')`
- `sendMessage({customType, display: false}, {triggerTurn: true})`
- `sessionManager.getBranch()`, `getSessionId()`, `getLeafId()`

### Probe 4: SessionManager API 运行时验证 ✅

**文件**: `probes/04-session-manager-api.ts`

使用 `SessionManager.open()` 打开真实 session 文件：

```
Session ID: 019ef89e-b487-7d82-a0ad-d854e90677fa
Branch entries: 82
Leaf ID: 500ef681
buildSessionContext() → 68 messages
Found failed toolResult: read(call_4a6f63e...) with isError=true
All 5 sampled toolCall→assistant mappings matched
```

结论：`getBranch()` 返回从 leaf 到 root 的完整路径，可以安全地逆序遍历查找 isError。`buildSessionContext()` 产生的消息数组结构与 context 事件中收到的一致。

### Probe 5: 运行时扩展加载 ✅

**文件**: `probes/05-runtime-load.sh`

在真实 pi 环境中测试：

```
$ pi -p -e test-ext.ts "test"
[pi-thefuck-test] Extension loaded!
[pi-thefuck-test] Context event #1: 2 messages

$ pi -p -e test-ext.ts "/fuck-test"
[pi-thefuck-test] Extension loaded!
[pi-thefuck-test] /fuck-test invoked
[pi-thefuck-test] Branch entries: 4
[pi-thefuck-test] No failed tool calls found
[pi-thefuck-test] Session ID: 019f02d0-...
[pi-thefuck-test] IsIdle: true, HasPending: false
```

结论：
- Extension 加载 ✅
- 命令注册 ✅
- `getBranch()` 运行时返回数据 ✅
- `context` 事件触发 ✅
- `isIdle()`/`hasPendingMessages()` 正常工作 ✅

### 总体可行性结论

| 设计步骤 | 可行性 | 风险 |
|---------|--------|------|
| 遍历 branch 找 isError toolResult | ✅ 已验证 | 低 |
| 回溯匹配 assistant 中的 toolCall | ✅ 已验证 | 低 |
| context 事件过滤消息 | ✅ 已验证 | 低 |
| sibling toolCall 保留 | ✅ 已验证 | 低 |
| sendMessage invisible continuation | ✅ API 存在 | 低（pi-bump 已验证） |
| registerCommand('/fuck') | ✅ 运行时验证 | 低 |
| 双击 Escape 快捷键 | ✅ `onTerminalInput` + `matchesKey` | 中（需要 TUI 模式验证） |
| 幂等性（多次 fuck） | ✅ 已验证 | 低 |

唯一未在运行时完全验证的是**双击 Escape 快捷键**— 因为需要在 TUI 模式下才能接收终端键盘事件。但这与 pi-bump 已验证的双击 Enter 实现逻辑完全一致，只需将检测的 key 从 `Key.enter` 改为 `Key.escape`。

## 里程碑

1. ✅ 研究阶段（thefuck 哲学 + pi session 机制 + pi-bump 参考）
2. ✅ 需求对齐（grill 用户）
3. ✅ 实际 session 文件分析
4. ✅ 设计文档（本文档）
5. ✅ 可行性验证（5 个 probe 全部通过）
6. ⏳ 实现：查找 + context 过滤逻辑
7. ⏳ 实现：`/fuck` 命令注册
8. ⏳ 实现：双击 Escape 快捷键
9. ⏳ 测试与调试