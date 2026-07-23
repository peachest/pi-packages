# 统一事件模型修正：从 respond_complete 到 activity_burst

ADR-0002 的三层架构假设所有 Agent 框架提供离散的 per-response 事件，但 Claude Code 的状态行机制是快照驱动（stdin pipe 周期传入累计数据），无法原生产出 `response_complete` 事件。本文档修正 `UnifiedEvent` 的事件类型语义，使 pi 和 Claude Code 两个不对称环境能被同一套 Mod API 消费。

## 问题

ADR-0005 定义的 `response_complete` 事件字段（`outputTokens`、`durationMs`）直接映射了 pi 的 `turn_end` 语义——"一次 LLM 响应完成"。Claude Code 的 StatusJSON `total_output_tokens` 等字段是会话累计值，不存在 per-response 边界。强制 CC 适配层合成 `response_complete` 会导致：

- 刷新间隔不一定对齐 LLM 响应边界——一次刷新可能覆盖多次响应或部分响应
- CC 适配层复杂性过高，违反 "轻量层" 的设计意图
- 合成事件的 `responseId` 和 `durationMs` 精度不可靠

同时，属性计算公式（如 `core.exp = tokens * 0.1`）是 core mod 的游戏逻辑，不应由适配层预计算后塞入事件——Mod 需要保有计算自主权。

## 决策

### 1. 事件重命名：语义从"响应"改为"活动"

| 旧事件类型 | 新事件类型 | 语义 | 数据字段 |
|-----------|-----------|------|---------|
| `response_complete` | `activity_burst` | 一段 token 消耗活动 | `inputTokens`, `outputTokens`, `durationMs` |
| `context_update` | `context_snapshot` | 上下文窗口状态快照 | `usedPercentage`, `contextWindowSize` |

**`activity_burst`** 不承诺与"一次 LLM 响应"一一对应。它表示"自上次事件以来的一段 token 消耗活动"。pi 适配层在 `turn_end` 发出（天然对齐一次响应），CC 适配层在快照刷新时计算增量后发出（可能覆盖多次响应或部分响应）。

**`context_snapshot`** 表示某一时刻的上下文窗口占用状态。pi 适配层在 `context` 事件触发时发出，CC 适配层直接透传 StatusJSON 中的 `used_percentage`。

### 2. 适配层职责：归一化，不计算

```
原始 Agent 数据        适配层归一化              Mod 消费
─────────────────    ───────────────────    ──────────────────
pi turn_end       →   activity_burst        core mod:
  outputTokens         {inputTokens,          pet.on("activity_burst",
  durationMs           outputTokens,           (e) => pushAttributes({
                       durationMs}              "core.exp": e.inputTokens * 0.1
                                              })
CC StatusJSON      →  activity_burst
  delta_input          {inputTokens,
  delta_output         outputTokens,
  delta_time           durationMs}
```

适配层只做两件事：
1. **提取/计算增量值**（pi 的事件天然增量，CC 的快照需对比累计值做差值）
2. **包装为统一事件**推送给 core-framework

属性计算公式（token → exp、context% → fullness）保留在 core mod 中。适配层不碰游戏逻辑。

### 3. responseId 降级为可选元数据

`activity_burst` 事件携带可选 `responseId` 字段：

- pi 适配层：填入自行生成的 UUID
- CC 适配层：填入自行生成的 UUID 或递增计数器

binlog 幂等性由 `sessionId + seq` 保证，`responseId` 仅做人类可读标签。

### 4. Mod API 不变

Mod 仍通过 `pet.on("activity_burst", handler)` 和 `pet.on("context_snapshot", handler)` 订阅事件，通过 `pet.pushAttributes(delta)` 推送属性增量。事件类型名称变化不影响 Mod 编程模型。

## 备选方案

**保持 `response_complete`，CC 适配层合成事件。** 拒绝原因见上文——刷新间隔不确定性导致合成事件的语义不可靠。

**适配层直接产出 `AttributeDelta`，Mod 不再处理事件。** 已拒绝：违背 Mod 保留计算自主权的设计原则。core mod 的 token → exp 映射是游戏逻辑，不应归属适配层。

**为每个 Agent 框架定义独立的事件类型。** 已拒绝：违背"Mod 跨 Agent 可复用"的设计目标。

## 与已有 ADR 的关系

- **ADR-0002**（三层架构）：适配层 + core-framework + mod 的分层结构不变。修正点仅在于统一事件类型的语义更宽泛（"活动"而非"响应"）。
- **ADR-0005**（pi 适配层设计）：事件映射表更新为 `turn_end` → `activity_burst`、`context` → `context_snapshot`。其余（渲染、命令注册、生命周期）不受影响。

## 与已有 ADR 的关系

- **ADR-0005**（pi 适配层）：事件类型名称更新为本文档定义的类型
- **ADR-0007**（Claude Code 适配层）：CC 适配层产出同一套事件类型

## 影响

- pi 适配层实现基本不变——事件重命名是单行改动
- CC 适配层实现大幅简化——只需做简单的累计值差值计算，无需合成 per-response 语义
- core mod 无需感知 Agent 来源差异——pi 和 CC 的 `activity_burst` 格式完全相同
- binlog 条目结构不变——仅事件类型名称更新
