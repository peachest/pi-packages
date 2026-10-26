# ADR-0001: pi package 的非交互复现与修复后验证契约

**状态**：已采纳
**日期**：2026-08-31

## 背景

pi package（扩展）的加载期代码（extension bind、hook 注册、模块解析）运行在 pi 自身进程内，受 pi 的 jiti loader 和 pi 版本影响。单元测试（vitest）在 pi 的 loader 之外运行，**看不到这条代码路径**。

2026-08-24 的修复 `13dc5f9`（pi-proxy dispatcher 解析）有通过的单测（`dispatcherPathFromMain` 纯函数），但 2026-08-31 pi 升级 0.84.3→0.84.4 后回归：jiti 不再把 alias 映射应用到 `import.meta.resolve`，`import.meta.resolve("@earendil-works/pi-coding-agent")` 直接抛 `Cannot find module`。这个 bug 发生在 pi 的扩展加载阶段，vitest 根本碰不到——单测一直绿，但真实 pi 启动一直红。

根因不是修复写错了，而是**从未存在一个能在这一类 bug 上变红的命令**。修复缺少一个跟随 pi 真实加载路径的反馈环。

## 决策

本仓库所有 pi package 的 bug 修复必须遵守：

1. **复现先行**：在进入假设阶段前，必须有一个非交互的、能在该 bug 上变红的命令。该命令必须是 `pi -p "<最小 prompt>" --offline`（或针对该命令的 curl/CLI 脚本），通过 grep / exit code 断言用户的**确切症状字符串**，而非「没崩溃」。
2. **同一命令验证**：修复未完成，直到该命令变绿。修复后再跑一次原始（未最小化）场景确认。
3. **无 TTY 约束**：修复过程交给 agent 执行，没有 TTY。所有断言必须基于 grep / exit code，不能依赖人眼看 TUI。

纯函数仍需单测，但单测**不构成**修复完成的充分条件——它覆盖不到 pi loader 层。

## 权衡

| 选项 | 优点 | 缺点 |
|---|---|---|
| **非交互 `pi -p` 契约（采纳）** | 走 pi 真实加载路径，能抓 loader 层回归；agent 可无人值守执行；秒级 | 比 sub-second 单测慢（数秒）；需 `--offline` 和最小 prompt 收紧 |
| 手动交互复现 | 直观 | 不可 agent 执行、不确定、正是本次「修了又回归」的成因 |
| 仅靠 vitest 单测 | 快、确定 | 运行在 pi loader 之外，扩展加载回归对它不可见 |
| 编程式 pi 集成测试 harness | 最精确 | 构建成本高；`pi -p` 已提供走真实加载路径的非交互启动，暂不需要 |

## 后果

- 反馈环是真实的 pi 启动，能抓 vitest 抓不到的 loader 层回归。
- `pi -p` 启动完整扩展集，所以环路是数秒级（可接受）。用 `--offline` + 最小 prompt 收紧。
- grep 断言必须锚定确切症状字符串（如 `Could not locate`），不能用「运行无报错」这种泛化判断。
- 操作步骤见 `docs/agents/debugging-pi-packages.md`，agent 下次照此执行。
