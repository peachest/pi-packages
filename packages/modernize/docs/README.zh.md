# modernize

> English · [中文文档](./README.zh.md)

> 自动检测并修复 Go 和 TypeScript/JavaScript 代码中的过时语言特性。

一个 [pi](https://github.com/earendil-works/pi-coding-agent) 包，让你的代码库始终使用最新方言——主动编写现代语法，审查过时模式，并自动修复。

## Skills（技能）

### `modernize-fix`

自动检测并修复 Go 和 TypeScript/JavaScript 代码中的过时语言特性。在尊重项目目标语言版本的前提下应用现代语法替换。

触发条件：当你要求 pi 修复或更新代码、应用现代语法、或升级代码库时。

### `modernize-review`

审查 Go 和 TypeScript/JavaScript 代码中已废弃的 API、语言已简化的冗长模式、以及在保持与项目目标版本兼容的前提下可以用现代语法重写的代码。

触发条件：当你要求 pi 审查代码、审计质量或检查过时模式时。

## 参考

- [Go 现代特性](./references/go.md) — 从 Go 1.21 到 1.26 的逐版本变更日志，含旧→新替换速查表
- [TypeScript / JavaScript 现代特性](./references/ts.md) — 从 TS 4.x 到 5.7 的逐版本变更日志，含 ES2022+ JavaScript 特性与 Node 兼容性说明

## 背景

现有的审查工具（simplify skill、open-code-review、ponytail）在代码质量和简化方面做得很好，但都没有专门识别**正确但过时**的语言特性。一个 agent 可能在 1.24 项目中生成完全有效的 Go 1.19 代码——没有 bug，无需简化，只是使用了语言已提供更好替代方案的旧模式。

本包填补了这一空白：它知道每个语言版本支持哪些现代语法，并标记（或重写）落后的代码。对于 Go 1.26+ 项目，它还利用 `go fix` 作为规范的现代化工具。对于 TypeScript/JavaScript，转换基于项目的 `tsconfig.json` target 和 `engines.node` 确定。

## 安装

```bash
pi install /path/to/modernize
```

或从 npm 安装（如果已发布）：

```bash
pi install npm:modernize
```

## 测试

```bash
npm test
```
