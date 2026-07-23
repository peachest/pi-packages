# Claude Code 适配层设计

Claude Code 与 pi 的扩展模型根本不同——CC 不提供编程式事件钩子或命令注册 API，只提供状态行 JSON pipe（StatusJSON）和 Hook 机制。本文档定义 CC 适配层的调用模型、缓存策略、binlog 目录结构和 Growth 阶段预留的 Hook 架构。

## 决策

### 1. 作为 ccstatusline CustomCommand widget 嵌入

CC 适配层不替换 ccstatusline，而是作为 ccstatusline 的 `CustomCommand` widget 嵌入。用户在 ccstatusline TUI 中添加一个 CustomCommand widget，指向 `pet-cc-adaptor` 可执行文件。

```
Claude Code 刷新状态行
  → ccstatusline 运行
    → CustomCommand widget: execSync("pet-cc-adaptor", { timeout: 5000 })
      → StatusJSON 通过 stdin 传入
      → pet-cc-adaptor 计算增量 → 写 binlog → 重放 → 格式化状态行 → stdout
    → ccstatusline 捕获 stdout → 嵌入状态行
```

**理由**：
- 用户保留 ccstatusline 的 git、model、token 等已有 widget——无功能损失
- StatusJSON 透明透传——pet-cc-adaptor 接收与 ccstatusline 相同的数据
- 安装简化为一行 CustomCommand 配置——无需替换 Claude Code 的 `statusLine.command`

**备选方案**：
- **替换 ccstatusline**：已拒绝，用户失去所有已有 widget
- **包裹 ccstatusline（链式调用）**：已拒绝，额外子进程开销 + 双倍 StatusJSON 解析

### 2. 状态缓存：复用 ccstatusline git cache 模式

pet-cc-adaptor 作为短生命周期 CLI（每次调用即退出），每次启动需要读取 binlog 做重放。借鉴 ccstatusline git widget 的双层缓存模式避免重复 I/O。

**缓存位置**：`~/.cache/agent-pet/cc-adaptor/{sessionId}.json`

**缓存条目**：
```typescript
{
  lastBinlogSeq: 42,        // 上次处理到的 binlog seq
  attributes: {              // 缓存的属性快照
    "core.exp": 2400,
    "core.fullness": 78
  },
  lastSnapshot: {            // 上次 StatusJSON 关键字段
    totalOutputTokens: 15000,
    totalInputTokens: 80000
  },
  prevCtxPct: 78,            // 上次 context used_percentage（compaction 检测用）
  prevWindowSize: 200000,    // 上次 context_window_size（compaction 检测用）
  cachedAt: 1716820000000,
  binlogMtimeMs: 1716820000  // binlog 文件 mtime
}
```

**双重失效策略**：
1. **TTL 过期**：默认 5 秒（匹配 ccstatusline 默认刷新间隔）
2. **binlog mtime 变化**：pi 侧写入新 binlog 条目时立即失效，触发增量重放

**效果**：两台 Agent 未活动时，每次 CC 刷新直接返回缓存状态行（< 5ms，零 I/O）；pi 侧有活动后首次 CC 刷新触发增量重放（~50ms）。

### 3. 事件映射

| 统一事件 | CC 数据来源 | 计算方式 |
|---------|-----------|---------|
| `activity_burst` | StatusJSON `context_window.total_input_tokens` / `total_output_tokens` | 与缓存中 `lastSnapshot` 对比计算增量 |
| `context_snapshot` | StatusJSON `context_window.used_percentage` / `context_window_size` | 直接透传 |

CC 适配层只做归一化——累计值差值 → `activity_burst`。属性计算公式保留在 core mod 中。

**`durationMs`**：两次 StatusJSON 刷新时间戳差值。

**`responseId`**：降级为可选元数据，填入自增计数器或 UUID。binlog 幂等性由 `sessionId + seq` 保证。

### 4. binlog 目录

```
.pet/binlog/
├── pi/
│   └── {pi-session-id}.jsonl        # pi 写入
└── claude-code/
    └── {cc-session-id}.jsonl         # CC 写入
```

按 Agent 来源分子目录，避免 pi 和 CC 的 session ID 命名空间冲突。`sessionId` 存储 Agent 原生的 session 标识（pi: 文件路径，CC: StatusJSON `session_id`）。

重放引擎通配 `.pet/binlog/*/` 下所有文件，聚合所有 Agent 的 binlog 条目。

### 5. Checkpoint 触发：监控 context used_percentage

CC 不暴露 compaction 事件，但 StatusJSON 的 `context_window.used_percentage` 可检测 compaction。

复用 ccstatusline `detectCompaction()` 的检测逻辑：
- 缓存 `prevCtxPct` 和 `prevWindowSize`
- 每次刷新时对比当前值：若 `used_percentage` 下降超过阈值（默认 2 点）且 `context_window_size` 未变 → 触发 checkpoint
- 若 `context_window_size` 变化（模型切换或 context window 配置变更）→ 重置基线，不计入 compaction

pi 侧 `/compact` 是显式触发，CC 侧百分比下降是隐式检测。两者写入同一 checkpoint，先到先写。

### 6. Growth 阶段：Hook 架构

MVP 阶段属性计算搭载在 statusline 刷新上（~10 秒间隔）。Growth 阶段通过 Claude Code Hook 机制提升更新粒度：

```
Claude Code Hook 触发 (PreToolUse / UserPromptSubmit / 每次 LLM 响应)
  → hook 脚本 → pet-cc-adaptor --hook
    → 接收 hook JSON → 计算 attribute delta → 写入 binlog / 更新 cache 文件

Statusline 刷新 (10s 间隔)
  → CustomCommand widget → pet-cc-adaptor
    → 读取 cache 文件 → 重放 binlog → 格式化 → stdout
```

**Hook 已知事件**（来自 ccstatusline 探索）：
- `PreToolUse`：工具调用前触发，可检测 Skill 调用
- `UserPromptSubmit`：用户提交 prompt 时触发，可捕获 `/skill-name` 命令

**优势**：
- 计算频率脱离 statusline 间隔——hook 可在每次 LLM 响应后触发，接近 pi 的 `turn_end` 粒度
- 渲染零等待——statusline widget 只读缓存
- binlog 写入更实时——不依赖 10 秒轮询

### 7. 仪表盘

CC 无编程式命令注册 API（`/pet` 不可用）。替代方案：
- pet CLI 支持 `--dashboard` 标志，用户在终端直接运行查看面板
- 可选：通过 `~/.claude/skills/pet/SKILL.md` 创建 Agent Skill，让 Claude 在用户输入 `/pet` 时调用 `pet-cc-adaptor --dashboard` 并输出结果

## 备选方案

**CC 适配层替换 ccstatusline。** 已拒绝：用户失去所有已有 widget。

**CC 适配层作为长生命周期守护进程。** 已拒绝：增加运维负担（进程管理、端口分配），缓存模式已解决短进程的性能问题。

**CC 适配层合并计算与渲染在同一 `execSync` 中。** MVP 可行但 Growth 阶段应通过 Hook 解耦——计算和渲染的刷新频率需求不同。

## 与已有 ADR 的关系

- **ADR-0002**（三层架构）：CC 适配层是其实现，适配层 + core-framework + mod 三层不变
- **ADR-0005**（pi 适配层）：pi 和 CC 适配层对等，产出同一套 `activity_burst` / `context_snapshot` 事件
- **ADR-0006**（统一事件模型修正）：CC 适配层遵守同一事件类型定义

## 影响

- CC 适配层安装为一个 CustomCommand widget 配置——无额外进程管理
- CC 适配层缓存确保短生命周期 CLI 性能——缓存命中 < 5ms，增量重放 ~50ms
- binlog 写入 `.pet/binlog/claude-code/{session-id}.jsonl`
- Hook 架构作为 Growth 阶段预留，MVP 不实现
- 仪表盘通过 `--dashboard` 标志在终端手动查看
