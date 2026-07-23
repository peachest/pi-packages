# pi-thefuck

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> English · [中文文档](./README.zh.md)

**像 [thefuck](https://github.com/nvbn/thefuck) 一样，为 [pi agent](https://github.com/badlogic/pi-mono/) 撤销最近失败的 tool call。**

当 LLM 调用的工具执行失败时（bash 命令错误、对目录执行 read 等），输入 `/fuck` 将该次失败的调用从上下文中移除，让 agent 自动重试。

## 安装

```bash
pi install npm:pi-thefuck
```

或临时加载测试：

```bash
pi -e /path/to/pi-thefuck/index.ts
```

安装后重启 pi 或执行 `/reload`。

## 使用方法

### `/fuck` 命令

当 agent 回复中包含执行失败的 tool call 时，输入：

```
/fuck
```

失败的 tool call 会从 LLM 上下文中移除，agent 自动重试。

### 双击 `f` 快捷键

在**空编辑器**状态下，快速按两次 `f`（300ms 内），等效于 `/fuck` 命令。

仅在 agent 空闲时触发。单次按 `f` 正常输入字符。

### 示例

```
assistant: 让我查看一下项目...
  toolCall: read(path="issues/")     ← EISDIR — 读的是目录
  ↓
  toolResult(read, isError: true)    ← 失败了！

→ /fuck

assistant: 哦，那是目录，让我用 ls 查看。
  toolCall: bash("ls issues/")
  ↓
  toolResult(bash, ok)               ← 成功了
```

## 功能特性

| 特性 | 说明 |
|------|------|
| **不修改 session 文件** | 只在 LLM 上下文中过滤，不对磁盘上的 JSONL 做任何改动 |
| **批次限定** | 只取消最近一次 assistant 回复中的失败，不会跨越多轮查找 |
| **一次一个** | 多个失败需要多次 `/fuck` 逐个撤销，类似 thefuck 一次修一个错误 |
| **幂等** | 已经 fuck 过的 tool call 再次 `/fuck` 不会重复处理 |
| **兄弟安全** | 同一批次中成功的 tool call 全部保留 |
| **无冲突** | 双击 `f` 不与任何内置快捷键冲突 |

## 工作原理

pi-thefuck 使用 pi 扩展的 `context` 事件，在消息发送给 LLM 前进行内存级过滤：

1. 在当前分支中找到**最后一个包含 tool call 的 assistant 消息**
2. 检查该批次中是否有 tool result 标记了 `isError: true`
3. 如果找到，将该 toolCall + 对应 toolResult 从上下文中移除
4. 发送不可见的 `Continue` 信号触发重试

磁盘上的 session JSONL 文件不受影响。所有过滤发生在内存中，每次 LLM 调用独立计算。

## 与 pi-bump 共存

两个扩展可以同时安装，互不冲突：

| | pi-bump | pi-thefuck |
|---|---|---|
| 快捷键 | 双击 Enter | 双击 `f` |
| 作用 | 让 agent 继续 | 撤销失败的 tool call |
| 适用场景 | agent 停住了 | agent 出错了 |

## 致谢

- [thefuck](https://github.com/nvbn/thefuck) — 原始的命令修正工具，启发本项目的哲学
- [pi-bump](https://github.com/alexleekt/pi-bump) — `ctx.ui.onTerminalInput()` 双击模式在此被复用为 `f` 快捷键

## 协议

MIT