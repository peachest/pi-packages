# ADR-0002: 本地路径包的安装正典——settings 相对路径 + pi npm 区 node link

**状态**：已采纳
**日期**：2026-10-26（用户拍板 node link 方案）

## 背景

pi 对 local-path 包的官方语义（docs/packages.md）："Local packages are not installed or modified, so their dependency tree remains the package author's responsibility"——pi 不装依赖，依赖树是作者责任。jiti 从扩展文件位置向上搜索 node_modules 解析依赖。

本仓 22 个包里 15 个以 `../../projects/pi-mypackage/packages/<name>` 相对路径安装在全局 settings。这个形态埋了两类事故，2026-10-26 一天内先后爆发：

1. **依赖解析断**（pi-ask-question）：包从 c2 worktree 迁到主检出后，`Cannot find module '@juicesharp/rpiv-config'`——worktree 根有完整依赖树而主检出没有，同一份 settings 一半包能加载一半不能。
2. **死链接装**（agent-renew 现状、ask-question 曾经）：settings 指向 worktree 路径，worktree 删除后安装指针悬空。

## 决策

**两层形态，各管一件事：**

1. **settings 保留相对路径条目**（官方 local 形态，单点注册，pi 加载源）。
2. **每个本地包额外软链进 `~/.pi/agent/npm/node_modules/<name>`**（链接名 = package.json 的 name，npm 正典；scoped 包进 `@org/` 子目录）。`scripts/link-pi-packages.sh` 维护（幂等 + `--prune` 清断链），post-commit hook（`scripts/githooks/post-commit`）对 HEAD 改动的包自动 relink——~/skills 仓 post-commit 自动重装模式的移植。

依赖供给走两条腿：软链让包在 pi npm 区**平级可见**（jiti 解析实证基点是链接位置而非 realpath——repo 根依赖移除后软链包仍命中 pi npm 区的 `@juicesharp/rpiv-config`）；同时 repo 根 devDependencies 显式声明运行时依赖（`811d2cf`：rpiv-config/rpiv-i18n），保证"在 repo 里跑测试/tsc"的解析链。

## 舍弃的替代方案

- **npm install 物理拷贝进 pi npm 区**（npm: 形态）：改源码后需重装同步——退回 ~/skills 模型，丢掉零拷贝即时生效；且 vendored 包的 sync.sh 流程会被 npm 覆盖。
- **只在 repo 根 devDeps 修（不 link）**：修好了"在 repo 里跑"，但 jiti 的解析基点仍是扩展文件位置——从 pi npm 区视角（未来任何 npm: 形态包 import 本仓包）依然断；且死链类 drift 无机制约束。
- **pi install npm: 发 npm 包**：需要发布流程，与 vendored fork（ask-question 改造自 rpiv）的本地迭代节奏冲突。

## 后果

- 正：依赖解析与 repo 检出位置解耦（worktree 里改包不再断链）；新包落地由 post-commit 自动补链，"建了忘装"消失；死链由 --prune 收敛。
- 负：pi npm 区出现非 npm 安装来源的软链——`pi update --extensions` 对它们的 reconcile 行为未定义，reconcile 报错时手动重跑 link 脚本即可。
- 负：链接名与目录名可能不同（scope 包），脚本必须读 package.json 的 name——已固化在脚本与 post-commit 内。
- 双加载红线：settings 相对路径条目**不得**再额外写 `npm:@hyx/...` 条目指向同一包——两份注册 = 扩展加载两次。
