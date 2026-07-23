⚠️  CODE EXPLORATION POLICY ⚠️

Priority using codegraph commands.
Only fall back to grep if codegraph can't answer.

# Agent Skills

> 本文件为工程技能（engineering skills）提供仓库级配置说明。
> 由 `setup-matt-pocock-skills` 技能自动生成，可手动编辑。

## Commit Trailer 规范（强制）

> AI 生成的提交（Commit）必须包含以下三个 Git Trailer 字段，
> 否则 `.githooks/commit-msg` hook 将拒绝提交。
> 纯人类手动提交不受此限制。

### 字段说明

| Trailer 字段 | 必填 | 说明 |
|---|---|---|
| `Agent-Task:` | ✅ | 关联的 Issue / 任务编号（如 `ISSUE-42` 或 `PROJ-123`） |
| `Agent-Model:` | ✅ | 生成此代码的 AI 模型名称（如 `Claude-4-Sonnet`、`DeepSeek-V4`） |
| `Agent-Decision:` | ✅ | 核心设计决策说明——为什么选择当前方案而非其他替代方案 |

### 提交格式示例

```
feat(auth): 接入刷新 Token 机制

- 实现 JWT 自动续期
- 添加 Token 过期检测与刷新逻辑

Agent-Task:     PROJ-234
Agent-Model:    Claude-4-Sonnet
Agent-Decision: 考虑了 Redis 存储方案，但为了降低依赖，最终采用 JWT 自动续期方案
```

### 审计追踪

出现问题后，可用以下命令快速定位：

```bash
# 搜索某工单的所有 AI 提交
git log --grep="^Agent-Task:"

# 搜索特定模型的所有提交
git log --grep="^Agent-Model:.*Claude"
```

## 问题跟踪

Issues 和 PRD 以本地 Markdown 文件形式管理，存放在 `.scratch/` 目录下。
详见 `docs/agents/issue-tracker.md`。

读取文档时，如果文档被标记已完成或已归档，并且完成/归档日期距离现在超过 7 天，则在遇到与当前需求或实现不一致的地方时
应该尽量以最新的为准。就文档不应该更新。

## 分类标签

分类使用默认的五角色词汇表（needs-triage、needs-info、ready-for-agent、ready-for-human、wontfix）。
详见 `docs/agents/triage-labels.md`。

## 领域文档

单上下文仓库：`CONTEXT.md` 位于仓库根目录，ADR 存放在 `docs/adr/` 下。
详见 `docs/agents/domain.md`。

# 文档编写

本项目使用等宽字体，1 个中文字符与 2 个英文字符等宽。