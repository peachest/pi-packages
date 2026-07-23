# pi 适配层：基于 pi Extension API 的事件映射与渲染设计

pi 适配层需要将 pi 原生事件（token 统计、上下文变化）转换为 core-framework 的 `UnifiedEvent`，并通过 pi 的 UI API 渲染状态栏和面板。本文档记录对 pi Extension API 的完整审计结果，确认五个关键能力面均可被 pi 公共扩展点覆盖，无需 pi 内部补丁。

## 决策

### 1. 适配层以 pi TypeScript 扩展形式实现

```
.pi/extensions/pet-adaptor/
├── package.json       # 声明 @pi-pets/core 依赖
├── package-lock.json
├── node_modules/      # npm install 后
└── index.ts           # export default function(pi: ExtensionAPI)
```

**理由**：
- pi Extension API 完全覆盖适配层所需的全部能力（事件拦截、状态栏渲染、命令注册）
- 目录结构 + `package.json` 支持 `@pi-pets/core` 等 NPM 依赖
- `.pi/extensions/` 被 pi 自动发现，支持 `/reload` 热重载
- 适配层与项目代码共存，无需独立仓库

**曾考虑**：pi package（通过 `pi install` 安装）。已拒绝：适配层是项目特定代码，额外打包/发布环节增加迭代摩擦，无明显收益。

### 2. 事件映射

| 统一事件 | pi 事件钩子 | 数据来源 |
|---------|-----------|---------|
| `response_complete` | `turn_end` | `event.message.usage.outputTokens`，`durationMs` 从 `turn_start`/`turn_end` 时间戳差值计算 |
| `context_update` | `context` | `ctx.getContextUsage().tokens`，`ctx.model.contextWindow` |

**`turn_end`** 在每个 LLM 响应 + 工具执行完成后触发一次，`event.message.usage` 包含 `inputTokens` / `outputTokens`。

**`durationMs`** 自行计时：`turn_start` 记录 `Date.now()`，`turn_end` 计算差值。pi 不暴露响应级别的原生 duration 字段。

**`context`** 在每次 LLM 调用前触发。`ctx.getContextUsage()` 返回 `{ tokens: number }` —— 聚合上下文占用。`ctx.model.contextWindow` 提供模型上下文窗口大小。

**sessionId**：`ctx.sessionManager.getSessionFile()`，会话文件路径稳定唯一。

**responseId**：自行生成 UUID。pi 不暴露单次响应级别的原生 ID，binlog 仅需幂等性，不依赖 pi 原生 ID。

### 3. 渲染

**状态栏**：`ctx.ui.setStatus("pet", text)` 将状态栏字符串渲染到 pi 页脚。每轮 `turn_end` 调用 `core.formatStatusLines(state)` 取 `lines[0]`。

```typescript
pi.on("turn_end", async (event, ctx) => {
  await core.pushEvent(toUnifiedEvent(event, ctx));
  const state = core.getState();
  ctx.ui.setStatus("pet", core.formatStatusLines(state)[0]);
});
```

备选 `ctx.ui.setWidget()`（编辑器上方/下方多行）预留作为多行能力扩展点。MVP 单行页脚与 PRD 对齐。

**面板**：`pi.registerCommand("pet", { handler })` 注册 `/pet` 命令，handler 内调用 `core.renderDashboard(state)`，通过 `pi.sendMessage()` 输出到对话区。

```typescript
pi.registerCommand("pet", {
  description: "显示宠物面板",
  handler: async (_args, ctx) => {
    pi.sendMessage({
      customType: "pet-dashboard",
      content: core.renderDashboard(core.getState()),
      display: true,
    });
  },
});
```

**刷新频率**：搭载在 `turn_end` 上——不在 Agent 关键路径上引入额外轮询。适配层对 pi 响应延迟无可感知影响。

### 4. 生命周期

```
pi 启动
  └─ session_start → 初始化 core-framework（加载 PetStore、执行重放）
       ↓
  用户发送 prompt
  └─ context → 发射 context_update 统一事件（可选：基于上下文占用触发喂食逻辑）
  └─ turn_start → 记录时间戳
  └─ turn_end → 发射 response_complete 统一事件 → 重放 → 刷新状态栏
       ↓
  用户执行 /pet
  └─ 命令 handler → core.renderDashboard() → 输出面板
       ↓
  session_shutdown / session_start(新 session)
  └─ 重新初始化 core-framework
```

### 5. Context Update 的触发策略

`context` 事件在每次 LLM 调用前触发，频率可能过高（每次 tool-call 轮次都触发）。MVP 暂不订阅 `context_update`：

- 饱腹度增长搭载在 `turn_end` → `response_complete` 上（每次响应完成触发一次）
- `context` 事件作为 Growth 阶段的预留钩子，用于能力维度（如"上下文感知"技能触发）

## 备选方案

**每个 Agent 单体实现。** 已拒绝：ADR 0002 已定义三层架构，mod 逻辑在各 Agent 间共享。

**pi 内部补丁，新增原生事件。** 已拒绝：审计确认 pi Extension API 的 `turn_end` + `context` + `setStatus` + `registerCommand` 已完全覆盖需求。pi 公共扩展点优先，补丁是最后手段。

**使用 `message_end` 而非 `turn_end`。** 已拒绝：`message_end` 在每个消息结束时触发（含 user、toolResult 消息），过滤复杂且易重复触发。`turn_end` 语义精确匹配"一次 LLM 响应完成"。

## 与已有 ADR 的关系

- **ADR-0006**（统一事件模型修正）：事件类型名称更新为 `activity_burst` / `context_snapshot`
- **ADR-0007**（Claude Code 适配层）：pi 和 CC 适配层对等，binlog 按 Agent 分子目录

## 影响

- 适配层实现为纯 TypeScript 扩展，零 pi 内部修改
- HITL 门控已解除——五个能力面均被 pi 公共 API 覆盖
- 适配层阻塞 #1~#5（core-framework + `@pi-pets/core` 可用）
- 扩展放在 `.pi/extensions/pet-adaptor/`，对 pi 响应延迟无可感知影响
- binlog 写入 `.pet/binlog/pi/{session-id}.jsonl`
