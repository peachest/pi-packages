# 宠物状态栏上下文百分比使用真实 API 数据

宠物状态栏需要显示与 pi 原生 footer 一致的上下文使用百分比（如 `18.6%/1.0M`）。最初尝试使用 pi 提供的 `ctx.getContextUsage().percent` 方法，但发现该方法返回的值始终与 footer 存在偏差，有时高达 5 倍。最终改用 `event.message.usage.input / ctx.model.contextWindow * 100` 直接计算。

## 问题

在 `turn_end` 事件处理器中调用 `ctx.getContextUsage().percent` 获取上下文百分比，然后写入 binlog 并显示在状态栏。结果始终与 pi 原生 footer 显示的百分比不一致：

| 场景 | Footer 显示 | Pet 状态栏显示 | 偏差 |
|------|-------------|---------------|------|
| 初始 | 13.8%/1.0M | 39% | ~3× |
| 尝试 getContextUsage().percent | 13.8%/1.0M | 54% | ~4× |
| 尝试 usage.input / contextWindow | 17.5%/1.0M | 72% | ~4× |
| 最终方案 | 19.5%/1.0M | 19.5% | 一致 |

## 根因

无论使用 `getContextUsage().percent` 还是 `usage.input / contextWindow`，偏差始终存在。原因在于 **调用时机不同导致底层数据状态不同**：

### 事件处理时序

pi 的 `turn_end` 扩展事件在会话状态更新之前触发。在 `agent-session.ts` 中：

```
_processAgentEvent(event):
  await this._emitExtensionEvent(event);   // ← 我们的 turn_end 处理器在此处执行
  this._emit(event);                        // ← 状态更新在此处执行（之后）
```

当我们的处理器执行时，`this.messages`（`getContextUsage()` 的输入源）尚未包含当前轮次的 assistant message 和 tool results。

### estimateContextTokens 的偏差

`getContextUsage()` 内部调用 `estimateContextTokens(this.messages)`，该函数：

1. 找到最后一个有 `usage` 数据的 assistant message（来自上一轮，因为本轮消息还未 commit）
2. 取 `usage.input + usage.output + cacheRead + cacheWrite` 之和
3. 加上之后所有消息的启发式字符估算（`chars/4`）

由于 tool results 在 `turn_end` 之前已被 agent-loop 添加到上下文中，步骤 3 的启发式估算会包含 tool result 的字符数，导致估算值偏高。Footer 在状态更新后渲染，`this.messages` 状态已稳定结果偏低。

## 决策

**直接使用模型的真实 API 数据计算上下文百分比**，跳过 `getContextUsage()` 的启发式估算。

```typescript
const inputTokens = event.message.usage?.input ?? 0;          // Anthropic API 返回的 input_tokens
const contextWindow = ctx.model?.contextWindow ?? 0;          // 模型定义的真实上下文窗口
const contextPercent = contextWindow > 0
  ? parseFloat(((inputTokens / contextWindow) * 100).toFixed(1))
  : 0;
```

- `usage.input` 是模型 API 直接返回的 `input_tokens`，即本次请求的累积输入 token 数
- `ctx.model.contextWindow` 是模型定义中的最大上下文窗口
- 两者都是精确值，不含启发式估算

### 状态栏与面板的一致性

状态栏在 `turn_end` 时显示实时计算的 `contextPercent`。`/pet` 面板读取 binlog 重放的值，与状态栏使用同一个公式，确保一致。

### 不受影响的场景

- 当 `contextWindow` 为 0（模型未加载或未配置）时，上下文百分比显示为 0
- binlog 中存储的值仍然使用 delta 编码，`computeDeltas` 内置的 memo 机制不受影响

## 备选方案

**继续使用 `getContextUsage().percent` 并接受偏差。** 已拒绝：偏差高达 5 倍，状态栏与 footer 不一致会破坏信任。

**使用 `getContextUsage()?.contextWindow` + `usage.input`。** 与最终方案思路相同，但 `getContextUsage()` 内部依赖 `this.model`（即 `ctx.model`），两者在 `turn_end` 时都可能为 `undefined`。`ctx.modelRegistry.find()` 直接从注册表查模型定义，不受 session 状态影响。

**在 footer 渲染后才刷新状态栏。** 已拒绝：需要引入延迟或轮询机制，违背"零性能影响"的设计原则。

## 影响

- 状态栏百分比与 pi 原生 footer 保持一致
- `/pet` 面板与状态栏使用同一公式，数据一致
- 不再依赖 `getContextUsage()`，消除了其内部启发式估算的不确定性
- 不引入额外 API 调用或轮询
