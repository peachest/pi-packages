# Ponytail — Best Practices, Pitfalls & Interface Contracts

## Best Practices

### 1. 配置文件分层解析

`ponytail-config.js`（`hooks/ponytail-config.js`）：

```js
// Resolution order for default mode:
//   1. PONYTAIL_DEFAULT_MODE environment variable
//   2. Config file defaultMode field (~/.config/ponytail/config.json)
//   3. 'full' (hardcoded default)
```

**模式**：环境变量 > 配置文件 > 硬编码默认值。三层的 fallback 确保在任何环境下都有可预测的行为。

### 2. Session 恢复

```js
// pi-extension/index.js
pi.on("session_start", async (_event, ctx) => {
  const entries = ctx?.sessionManager?.getBranch?.()
    || ctx?.sessionManager?.getEntries?.() || [];
  configuredDefaultMode = getDefaultMode();
  currentMode = resolveSessionMode(entries, configuredDefaultMode);
});
```

**模式**：启动时读取 session entries + 持久化默认值，最后覆盖内存状态。`resolveSessionMode()` 从最新到最旧扫描 `ponytail-mode` 类型的 custom entry。

### 3. Mode 持久化命令触发

```js
// pi-extension/index.js — 命令处理
pi.registerCommand("ponytail", {
  handler: async (args, ctx) => {
    const parsed = parsePonytailCommand(args, configuredDefaultMode);
    if (parsed.type === "set-mode") {
      setMode(parsed.mode, ctx);  // 更新内存 + pi.appendEntry
    }
    if (parsed.type === "set-default") {
      writeDefaultMode(parsed.mode); // 写 ~/.config/ponytail/config.json
    }
  },
});
```

### 4. Skill alias 的 Map 模式

```js
function sendAlias(skillName, args, ctx) {
  if (ctx?.isIdle?.() === false) {
    // streaming 中：作为 follow-up 排队
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  } else {
    // idle：立即发送
    pi.sendUserMessage(message);
  }
}
```

**关键**：检查 `ctx.isIdle()` 来判断是否在 streaming 中，选择不同的 delivery mode。

### 5. 安全输入处理

```js
// 路径安全检查：只允许普通路径字符
function isShellSafe(p) {
  return typeof p === 'string' && /^[A-Za-z0-9 _.\-:/\\~]+$/.test(p);
}
```

## Pitfalls to Avoid

### 1. 模式匹配误触发

`isDeactivationCommand()` 必须精确匹配整条消息，不能有子串匹配。否则对话中 "I want to add a normal mode selector" 会误关闭 ponytail。

### 2. Extension UI 的 mode 判断

```js
// 不要假设有 UI
ctx?.ui?.notify?.(...)  // 安全调用，无 UI 时静默
ctx?.ui?.notify(...)    // ❌ 可能抛异常
```

**模式**：所有 UI 操作使用可选链调用。

### 3. Session entries API 兼容性

```js
// getBranch 和 getEntries 的 fallback
const entries = ctx?.sessionManager?.getBranch?.()
  || ctx?.sessionManager?.getEntries?.() || [];
```

## Interface Contracts

### Extension API 签名

```typescript
// pi-extension/index.js export
// default export: (pi: ExtensionAPI) => void
export default function ponytailExtension(pi) { ... }

// 非默认导出供其他模块使用
export { filterSkillBodyForMode };
export const readDefaultMode = getDefaultMode;
export { writeDefaultMode };
export function resolveSessionMode(entries, fallbackMode) { ... }
export function parsePonytailCommand(text, defaultMode) { ... }
```

### Command handler 签名

```typescript
pi.registerCommand("name", {
  description: string,
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
});
```

### Event handler 签名

```typescript
// before_agent_start 必须返回 { systemPrompt } 来修改 prompt
pi.on("before_agent_start", (event) => {
  return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
});

// input 处理用户消息，可以返回 { action: "continue" } 或 { action: "handled" }
pi.on("input", (event) => {
  return { action: "continue" };
});
```

### Config 文件格式

```json
{
  "defaultMode": "full"
}
```

路径：`$XDG_CONFIG_HOME/ponytail/config.json` 或 `~/.config/ponytail/config.json`。