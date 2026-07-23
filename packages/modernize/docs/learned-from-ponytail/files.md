# Ponytail — File Map

## 核心包结构

| 文件 | 职责 |
|------|------|
| `package.json` | 声明 pi 包入口（extension + skills），定义 `scripts.test` |
| `pi-extension/index.js` | Extension 主入口：注册 `ponytail` 命令、`before_agent_start` 和 `input` 事件处理、mode 管理 |
| `pi-extension/package.json` | 测试用独立包（`"type": "module"`） |
| `pi-extension/test/extension.test.js` | Extension 单元测试（mock pi API，17 个测试用例） |
| `pi-extension/test/helpers.test.js` | Helper 函数单元测试 |
| `skills/ponytail/SKILL.md` | 主 skill：ponytail 行为指南（ladder、规则、强度等级） |
| `skills/ponytail-review/SKILL.md` | 代码评审 skill：只找过度设计 |
| `skills/ponytail-audit/SKILL.md` | 全仓库审计 skill：repo 级复杂度扫描 |
| `skills/ponytail-debt/SKILL.md` | 债务收集 skill：搜集 `ponytail:` 注释 |
| `skills/ponytail-gain/SKILL.md` | 效果展示 skill：benchmark 记分板 |
| `skills/ponytail-help/SKILL.md` | 快速参考 skill：所有命令一览 |

## Hooks（跨平台复用）

| 文件 | 职责 |
|------|------|
| `hooks/ponytail-config.js` | 配置解析（环境变量 → 配置文件 → 默认值），`isDeactivationCommand()` |
| `hooks/ponytail-instructions.js` | System prompt 构建 + SKILL.md 按 mode 过滤 |
| `hooks/ponytail-activate.js` | Claude Code / Cline 等平台的激活脚本 |
| `hooks/ponytail-runtime.js` | 运行时检测和路由 |
| `hooks/ponytail-mode-tracker.js` | Mode 追踪工具函数 |
| `hooks/ponytail-statusline.sh` | Shell status line 生成（bash/zsh） |
| `hooks/ponytail-statusline.ps1` | Shell status line 生成（PowerShell） |

## 平台适配

| 目录 | 目标平台 |
|------|----------|
| `.claude-plugin/` | Claude Code |
| `.clinerules/` | Cline |
| `.cursor/rules/` | Cursor |
| `.github/plugin/` | GitHub Copilot |
| `.windsurf/rules/` | Windsurf |
| `.kiro/` | Kiro |
| `.opencode/` | OpenCode |
| `.openclaw/skills/` | OpenClaw |
| `.codex-plugin/` | Codex CLI |
| `commands/` | Cline commands（TOML） |
| `gemini-extension.json` | Gemini |
| `ponytail-mcp/` | MCP 兼容层 |

## 工具脚本

| 文件 | 职责 |
|------|------|
| `scripts/build-openclaw-skills.js` | 从 pi skills 构建 OpenClaw 格式 |
| `scripts/check-rule-copies.js` | 验证各平台规则副本的一致性 |

## 关键测试文件

`pi-extension/test/extension.test.js` — 测试模式：

1. `createPiHarness()` — mock pi API（events Map + commands Map）
2. `createCommandContext()` — mock `ExtensionCommandContext`
3. `withTempConfig()` — 临时配置文件隔离
4. 直接调用 `events.get("name")(...)` 触发 handler 并 assert 返回值