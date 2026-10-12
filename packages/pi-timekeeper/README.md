# pi-timekeeper

Codex 式时间感知 for pi：在 run 边界以**拉式注入**一行时间锚，让模型知道"现在"——绝不唤醒空闲会话，绝不触碰 system prompt。

```text
<time_anchor>It is 2026-10-12 (Monday) 07:25:22, UTC.</time_anchor>
```

## 安装

```bash
pi install ./packages/pi-timekeeper   # 本仓内
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `TIMEKEEPER_REMINDER_ENABLED` | `true` | reminder 节流开关（`"false"`/`"0"` 关） |
| `TIMEKEEPER_INTERVAL_SECONDS` | `3600` | 两次锚定之间的最小间隔 |

日期变更（diff-date）条件常开无开关。两者任一到期，下一次 run 开始前注入一条锚；都不到期则零注入零 token。

## 机制

- **拉式注入**：锚只在 run 边界（`before_agent_start`）计算投递——LLM 调用本就要发生的时刻才可能注入。无 timer、无队列，结构上不存在唤醒 idle 会话的路径（对齐 Codex `turn.rs:497` 的 step 边界拉取）。
- **重锚**：compaction 可能把旧锚摘要掉；压缩完成即置待重锚标志（`forcePending` 持久化进 state entry，进程崩溃后 resume 依然成立），下一个 run 无条件注入。
- **no-catch-up**：长时间未注入后，错过的 interval 不逐条补发，合并为下一次注入的一条锚。
- **分支跟随**：`/tree` 切分支后状态随分支恢复（session_tree 重扫）。
- **状态存档**：节流状态持久化在 session tree 侧 custom entry（`timekeeper.state`），永不进 LLM context；锚消息（`timekeeper.environment`）进 context 但 `display: false` 不刷 TUI。

## 已知 ceiling

拉式注入在**无 run 边界的连续工作区间**内不触发。本仓实测（AFK 训练 session 01a0a3b3，2026-09）：最长无边界拉伸 = **7.12h 单 prompt 轮询 run**（638 条目 / 320 turns，bash sleep 轮询训练任务），此期间锚冻结（含午夜跨日风险）。若日常实测不可接受，升级路径 = `context` 事件 per-turn transient 刷新（已在 spec #46 备好，未实现）。

## Out of scope（v1）

- `clock.sleep` 工具（Codex 第三层，延后）
- context 事件中途 transient 刷新（升级路径）
- gap 感知 / 信封时间戳 / 漂移检测（用户裁定排除；漂移检测归 pi-events-daemon）

## Domain

见 [CONTEXT.md](./CONTEXT.md)（词条表）与 [ADR 0001](./docs/adr/0001-pull-based-time-anchors.md)（拉式注入 vs timer/system-prompt 的取舍记录）。
