# pi-think-tool

> English · [中文文档](./README.zh.md)

为 pi coding agent 提供三个增强工具：**think**、**env**、**consequence**，让 agent 在多步操作链中更安全、更可审计。

## 安装

```bash
# 本地路径
pi install ./pi-think-tool

# 只测试不安装
pi -e ./pi-think-tool/think.ts
pi -e ./pi-think-tool/env.ts
pi -e ./pi-think-tool/consequence.ts
```

## 工具一览

### think — 记录推理过程

在工具调用之间写下当前判断，不获取新信息、不修改外部状态。

```
think({ thought: "分析完测试结果，确认 root cause 在 X 函数。下一步修复 Y。" })
→ 将思考追加到对话日志
```

**适用场景**：
- 拿到工具返回结果后，重新判断下一步
- 需要按政策/规则检查多条件组合
- 写下修复方案比较，避免直接改错方向

**来源**：Anthropic Engineering Blog — [The "think" tool](https://www.anthropic.com/engineering/think-tool)

---

### env — 记录环境上下文

将 agent 通过 bash/kubectl/git 等采集到的环境信息记录到对话中，供 consequence 等工具扫描。

```
env({ scope: "k8s", data: "Context: prod\nNamespace: default\n..." })
→ [env:k8s]
  Context: prod
  Namespace: default
```

**适用场景**：
- 执行操作前，收集目标环境的状态
- 记录 git 当前分支、远程、最新 commit
- 记录 k8s 集群 context、namespace
- 记录文件权限、类型、大小

**scope 可选值**：

| scope | 用途 |
|-------|------|
| `system` | OS、架构、用户、shell、node 版本 |
| `k8s` | k8s 集群 context、namespace、server 版本 |
| `git` | 当前分支、远程、状态、最新 commit |
| `file` | 文件路径、存在性、大小、类型、依赖 |
| `project` | 项目根目录、包管理器、脚本、依赖 |

---

### consequence — 评估操作后果

在写文件、执行命令、k8s/git 操作之前，委托一个独立的子模型评估风险。

```
consequence({
  proposedAction: {
    operation: "edit",
    target: "src/config.ts",
    details: "将 DATABASE_URL 从 staging 改为 production"
  },
  context: {
    envSummary: "Git branch: main | 3 commits ahead | remote: origin"
  }
})
→ Risks:
  - [high] 生产数据库连接串写入了代码仓库
  - [medium] 当前分支未推送，变更可能丢失
  Decision: caution
```

**决策结果**：

| decision | 含义 |
|----------|------|
| `proceed` | 风险可控，可以执行 |
| `caution` | 存在风险，先处理再执行 |
| `abort` | 不应执行该操作 |

**子模型选择**：优先使用 `claude-sonnet-4`，不可用时回退到最便宜的可用文本模型。

## 文件结构

```
pi-think-tool/
├── think.ts          # think 工具扩展
├── env.ts            # env 工具扩展
├── consequence.ts    # consequence 工具扩展
├── package.json      # pi 包清单
├── README.md         # English
├── README.zh.md      # 中文
└── ideas/            # 设计文档（内部参考）
    ├── think.md
    ├── env.md
    └── consequence.md
```

## 开发

```bash
# 在项目目录下测试某个扩展
pi -e ./think.ts
pi -e ./env.ts
pi -e ./consequence.ts

# 重新安装（更新后）
pi remove ./pi-think-tool 2>/dev/null; pi install ./pi-think-tool
```

### 依赖

三个工具都依赖 pi 核心包的 `ExtensionAPI` 类型。`consequence.ts` 额外依赖 `@earendil-works/pi-ai` 的 `complete()` 做子模型推理。`typebox` 用于参数 schema 定义。

这些已在 `peerDependencies` 中声明，pi 在加载扩展时自动提供，无需单独安装。