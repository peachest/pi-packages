# Ponytail — Dependencies & Stack

## 核心技术栈

| 组件 | 选择 | 说明 |
|------|------|------|
| **包格式** | pi package (`package.json` + `pi` 字段) | 原生 pi 包，非 npm publish |
| **Extension 语言** | JavaScript (CommonJS `require`) | `hooks/` 下用 CommonJS（跨平台兼容），`pi-extension/index.js` 用 ESM |
| **测试框架** | Node.js built-in test runner (`node:test` + `node:assert/strict`) | 零依赖，`node --test` |
| **状态持久化** | `pi.appendEntry()` + 文件系统 | session entries + config JSON 文件 |
| **Config 存储** | `~/.config/ponytail/config.json` | XDG 兼容，有平台 fallback |
| **MCP 支持** | `ponytail-mcp/` 独立子包 | 使用 `@modelcontextprotocol/sdk` |

## 零外部依赖

ponytail 除了 `ponytail-mcp/` 子包外，核心包没有 npm 外部依赖。测试用 Node.js 内置的 `node:test` + `node:assert`，不用 jest/mocha/vitest。

```json
// package.json
{
  "scripts": {
    "test": "node --test tests/*.test.js && npm test --prefix pi-extension"
  }
  // 没有 devDependencies!
}
```

## 构建工具链

| 工具 | 用途 |
|------|------|
| `node --test` | 运行测试 |
| `node --check` | 检查 JS 语法 |
| `scripts/build-openclaw-skills.js` | 从 pi skills 编译 OpenClaw 格式 |
| `scripts/check-rule-copies.js` | 验证各平台规则一致性 |

## pi API 依赖

Extension 依赖以下 pi API（`@earendil-works/pi-coding-agent`）：

| API | 用途 |
|-----|------|
| `pi.registerCommand()` | `/ponytail`, `/ponytail-review` 等命令 |
| `pi.on("before_agent_start")` | 注入 system prompt |
| `pi.on("input")` | 检测 stop/normal mode 命令 |
| `pi.on("session_start")` | 恢复 session mode |
| `pi.appendEntry()` | 持久化 mode |
| `pi.sendUserMessage()` | 触发 skill alias |
| `ctx.isIdle()` | 判断是否在 streaming |
| `ctx.ui.notify()` | 用户反馈 |
| `ctx.sessionManager.getBranch/Entries()` | 读取 session 历史 |

## key differences from modernize

| 维度 | ponytail | modernize |
|------|----------|-----------|
| **模式** | 有 intensity 级别的 mode (off/lite/full/ultra) | 二值 mode (proactive/reactive) |
| **Hook 层** | 抽离 `hooks/` 独立模块跨平台复用 | 全部内联在 `pi-extension/index.js` |
| **skill 结构** | 主 skill + 5 个 companion skills | 2 个 companion skills (review + fix) |
| **参考文件** | 无（规则全在 SKILL.md） | references/ 目录存各语言语法参考 |
| **测试** | 17 个测试 + helper 测试，完全 mock pi API | 17 个测试，同样 mock 模式 |