# Ponytail — Core Patterns

## 1. 包结构（monorepo-style pi package）

```
ponytail/
├── package.json            # pi.extensions + pi.skills 声明
├── pi-extension/
│   ├── index.js            # 主入口：命令、事件、system prompt 注入
│   ├── package.json        # 独立包（仅供测试）
│   └── test/
│       ├── extension.test.js
│       └── helpers.test.js
├── hooks/                  # 跨平台 hooks（其他 agent 平台用）
│   ├── ponytail-config.js
│   ├── ponytail-instructions.js
│   ├── ponytail-activate.js
│   ├── ponytail-runtime.js
│   └── ponytail-mode-tracker.js
└── skills/
    ├── ponytail/            # 主 skill（被动模式的行为指南）
    ├── ponytail-review/     # companion skill
    ├── ponytail-audit/
    ├── ponytail-debt/
    ├── ponytail-gain/
    └── ponytail-help/
```

**关键模式**：`package.json` 用 `pi.extensions` + `pi.skills` 声明多个入口。Extension 做持久化状态管理，skills 做单向操作。

## 2. Extension 的三层架构

| 层 | 职责 | 文件 |
|---|---|---|
| **Config** | 持久化配置（文件读写、环境变量） | `hooks/ponytail-config.js` |
| **Instructions** | 构建注入的 system prompt 文本 | `hooks/ponytail-instructions.js` |
| **Extension 入口** | 注册命令、订阅事件、协调各层 | `pi-extension/index.js` |

Config 和 Instructions 从 extension 中抽离到 `hooks/`，既供 extension 用，也供平台的 hook 系统用。

## 3. 状态管理：Session 持久化 + 命令切换

```
输入 /ponytail ultra
  → registerCommand handler
  → pi.appendEntry("ponytail-mode", { mode: "ultra" })   # 持久化到 session
  → 设置 activeMode 变量                                    # 内存状态

重启 session
  → on("session_start")
  → resolveSessionMode(entries, defaultMode)               # 从 session 恢复
  → 设置 activeMode

每次 agent 调用
  → on("before_agent_start")
  → 根据 activeMode 注入/不注入
```

**模式切换的幂等性**：`/ponytail` 无参数返回 status，`/ponytail lite|full|ultra` 设置模式，`/ponytail default <mode>` 设置持久化默认值。

## 4. System Prompt 注入 / 过滤

核心在 `filterSkillBodyForMode()` 和 `getPonytailInstructions()`：

```js
// ponytail-instructions.js
function filterSkillBodyForMode(body, mode) {
  // 只保留 SKILL.md 中当前模式的 Intensity table 行和示例
  // 通用规则行（"No unrequested abstractions"）全部保留
}

function getPonytailInstructions(mode) {
  // 尝试从 SKILL.md 读取并过滤
  // 失败时回退到 getFallbackInstructions()（硬编码的默认指令）
}
```

**双保险**：SKILL.md 不可读时用内存中的 fallback 文本，不会静默失败。

## 5. Companion Skill 模式

每个 companion skill（review/audit/debt/gain/help）是一份独立的 `SKILL.md`：

```
skills/ponytail-review/SKILL.md   — "Review diffs for complexity"
skills/ponytail-audit/SKILL.md    — "Whole-repo scan for complexity"
skills/ponytail-debt/SKILL.md     — "Harvest ponytail: comments into ledger"
```

**Extension 注册命令映射到 skill**（`ponytail/index.js`）：

```js
// pi-extension/index.js
pi.registerCommand("ponytail-review", {
  handler: (_args, ctx) => sendAlias("/skill:ponytail-review", "", ctx),
});
```

映射方式：`sendAlias()` 函数往 session 发一条 `/skill:name` 消息作为 follow-up，这样 skill 通过正常 skill 触发机制加载。

## 6. Event 驱动的模式控制

```js
// pi-extension/index.js
pi.on("input", (event) => {
  // 检测 "stop ponytail" / "normal mode" 命令
  // 仅在整条消息完全匹配时生效（防止 "add a normal mode toggle" 误触发）
});
```

**安全设计**：`isDeactivationCommand()` 只在整条消息 trim 后完全等于"stop ponytail"或"normal mode"时才关闭，不会在普通对话中误触发。

## 7. 测试模式

```js
// pi-extension/test/extension.test.js
function createPiHarness() {
  // 模拟 pi API：events Map + commands Map
  // extension 只看到 mock pi，不依赖真实 pi 运行时
  const pi = {
    on(eventName, handler) { events.set(eventName, handler); },
    registerCommand(name, opts) { commands.set(name, opts); },
    appendEntry() {},
    sendUserMessage() {},
  };
  ponytailExtension(pi);
  return { events, commands, appendedEntries, sentUserMessages };
}

function createCommandContext(overrides = {}) {
  return { ui: { notify() {} }, ...overrides };
}
```

**测试范式**：纯单元测试，不启动 pi 进程。通过 `createPiHarness()` 创建 mock pi，然后手动触发 `events.get("eventName")(...)` 调用 handler 并断言返回值。