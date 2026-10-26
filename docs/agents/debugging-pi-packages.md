# 调试 pi package

当本仓库 `packages/*` 下的 pi package（扩展）出问题时，agent 必须按本流程执行。核心约束：**修复过程交给 agent，没有 TTY**——所有断言基于 grep / exit code，不能依赖人眼看 TUI。

这是 ADR-0001 的操作落地。决策理由见 `docs/adr/0001-non-interactive-repro-verification.md`。

## 为什么不能只靠 vitest

pi package 的加载期代码（extension bind、hook 注册、模块解析）运行在 pi 自身进程内，受 pi 的 jiti loader 和 pi 版本影响。vitest 在 pi loader **之外**运行，看不到这条路径。

历史教训：`13dc5f9` 修复 pi-proxy dispatcher 解析时有通过的单测，但 pi 0.84.3→0.84.4 升级后 jiti 不再把 alias 应用到 `import.meta.resolve`，回归发生——单测一直绿，真实 pi 启动一直红。因为**从未存在一个能在该 bug 上变红的命令**。

## Phase 1 — 建立非交互反馈环

在进入假设阶段前，必须有一个已经在该 bug 上跑红过的命令。

### 主环：`pi -p` + grep 断言

```bash
# 最小 prompt + offline（避免网络），grep 锚定用户的确切症状字符串
pi -p "<最小 prompt>" --offline 2>&1 | grep "<确切症状字符串>"
# grep exit 0 = 命中错误 = 红；exit 1 = 没命中 = 绿
```

要求：
- **锚定确切症状**：grep 用户报告的原始错误字符串（如 `Could not locate`），不要用「运行无报错」这类泛化判断。
- **最小 prompt**：`"x"`、`"hi"` 即可，bug 在扩展加载阶段就触发，不需要真实对话。
- **`--offline`**：跳过启动期网络操作，收紧环路，除非 bug 本身需要网络。
- **已跑红过**：必须展示一次红输出 + grep exit code，证明这个环能抓这个 bug。

### 探针扩展：观测 pi 内部状态

当需要看 pi 进程内的值（`process.argv[1]`、`process.execPath`、`import.meta.resolve` 行为）时，写一个一次性探针扩展：

```bash
cat > /tmp/probe-ext.ts <<'EOF'
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const out: string[] = [];
out.push(`argv1=${process.argv[1]}`);
out.push(`execPath=${process.execPath}`);
try {
  out.push(`resolve=${fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))}`);
} catch (e) {
  out.push(`resolve threw: ${(e as Error).message}`);
}
writeFileSync("/tmp/probe-result.txt", out.join("\n") + "\n");
export default function () { return { name: "probe" }; }
EOF
rm -f /tmp/probe-result.txt
pi -p "x" --offline -e /tmp/probe-ext.ts 2>&1 | grep -i "error" | head
cat /tmp/probe-result.txt
```

探针扩展在 pi 的 jiti loader 内执行，能观测到 vitest 看不到的 pi 内部解析行为。

## Phase 2 — 复现 + 最小化

跑红后，逐个砍掉输入、调用方、配置、数据，每砍一项重跑一次环，只保留对失败必要的元素。

## Phase 3 — 假设

生成 3–5 个可证伪的排序假设。每个必须能陈述预测：「若 X 是因，则改 Y 会让 bug 消失 / 改 Z 会让 bug 更严重。」先给用户看排序，他们常有领域知识能即时重排。

## Phase 4 — 插桩

每个探针对应 Phase 3 的一个具体预测，一次只改一个变量。给所有调试日志打唯一 tag（如 `[DEBUG-a4f2]`），最后 `grep` 清理。

## Phase 5 — 修复 + 验证（双验证）

修复完成需**同时**满足：

1. **非交互环变绿**：Phase 1 的同一命令重跑，grep exit 1（没命中错误）。
   ```bash
   pi -p "<原始 prompt>" --offline 2>&1 | grep -c "<确切症状字符串>"
   # 输出 0 = 修复
   ```
2. **纯函数单测通过**：对提取出的纯 helper 补单测（如 `dispatcherPathFromMain`、`findDispatcherUpward`）。
3. **原始场景复跑**：用未最小化的原始场景再跑一次环，确认不是最小化引入的假绿。

单测是必要的但不充分——它覆盖不到 pi loader 层。非交互环才是充分条件。

## Phase 6 — 清理 + 复盘

- 删除探针扩展和临时文件（`/tmp/probe-*.ts`、`/tmp/probe-result.txt`）。
- `grep` 确认所有 `[DEBUG-...]` 插桩已移除。
- commit message 写明**哪个假设被证明是正确的**，方便下一个调试者。
- 问：什么能从根本上预防这类 bug？若答案涉及架构（没有好的测试 seam、隐藏耦合），交给 `/skill:improve-codebase-architecture`。

## 模块解析的特别说明

pi package 常需定位 pi-coding-agent 的内部模块（如 `http-dispatcher.js`）。该包 `exports` 字段只有 `import`（无 `require`），CJS `require.resolve` 失败；且解析受 jiti loader 行为和 node 二进制位置影响。可用策略（按稳健性排序）：

1. `realpathSync(process.argv[1])` 向上查找 `dist/core/<target>.js`——跟随 pi 实际启动入口，与 node 二进制位置和 jiti 内部行为无关。最稳健。
2. `import.meta.resolve("<specifier>")`——曾经可靠（jiti 应用 alias），但 pi 0.84.4 起不再应用，作 fallback。
3. `process.execPath` 启发式（`/prefix/bin/node` → `/prefix/lib/node_modules/...`）——nix 管理的 node 下失效（execPath 解析进只读 store），作末位 fallback。

**不要依赖 jiti 的内部实现细节**（如「alias 会应用到 import.meta.resolve」）作为主策略——pi/jiti 升级即可打破。只依赖结构性事实（「pi 经由自身 cli 入口启动」）。
