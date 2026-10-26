# pi-agents

自建的用户全局 subagent 花名册（roster），通过 [pi-subagents](https://www.npmjs.com/package/pi-subagents) 的包内 agent 机制分发。装上后所有 session 共享同一套 agent 定义，单一真源，告别 `~/.pi/agent/agents/` 手工散养。

## 安装

```bash
pi install ./packages/pi-agents
```

优先级：user/project agents > 本包 agents > builtin。`~/.pi/agent/agents/` 保留为临时实验 agent 的 override 层，正式 agent 一律进本包。

## Roster

| 名字 | 角色 | 备注 |
|---|---|---|
| `worker` (builtin) | 一切实现/修复/编码 | 别发明 general-purpose |
| `researcher` | 检索调研（anysearch CLI、web） | aliases: anysearch-researcher, web-researcher, anysearch |
| `reviewer` (builtin) / `doc-reviewer` / `standards-reviewer` | 评审三件套 | |
| `challenger` | 对抗评审 | review-only |
| `claim-extractor` | 批量提取可验证 factual claims | fact-check 流水线配套 |
| `delegate` (builtin) | 轻量转发 | |
| `scout` (builtin) | 只读快速勘察 | |
| `evidence-auditor` (builtin) | 独立证据审计 | |

全局 AGENTS.md 的 "Agent roster" 节与这里同源，改动须两边同步。

## 约定

- 新 agent 进 `agents/<name>.md`，frontmatter 参考现有文件（`systemPromptMode: replace`、显式 `tools` 白名单）。
- 公开仓红线：agent 文件禁止出现内部绝对路径（用 `~/`）、节点名、内部域名——`scripts/sanitize-check.sh` 会拦。
- 派发侧契约（skill 命名、猜名禁令）见根 `AGENTS.md` 的 Subagent Usage 节。
