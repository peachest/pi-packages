# pi-think-tool — 设计文档

## 概述

三个 pi 扩展工具，让多步 agent 操作更安全、可审计：

- **think** — 工具调用间的推理记录
- **env** — 操作前采集环境快照
- **consequence** — 执行前评估操作后果

## Think

**灵感**: [Anthropic Engineering Blog — The "think" tool](https://www.anthropic.com/engineering/think-tool)

一个不会修改外部状态的工具，只将当前思考追加到会话日志。关键在于时间点——发生在工具调用之间，拿到新结果后重新判断下一步，而非生成回复前的前置规划。

与 extended thinking 的分工：
- extended thinking：生成前的前置规划（代码、数学、文档分析）
- think：工具链中的中途复核（政策检查、规则验证、多步依赖）
- Anthropic 2025-12 更新建议：多数场景优先用 extended thinking；think 仍适合需要处理新信息、复核规则的长工具链

**适用场景**（三类优先启用）：
1. 工具返回值需要解释（订单状态、测试失败、API 异常）
2. 多步动作互相依赖（查订单→查政策→退款）
3. 政策规则密集（改签、退款、权限审批）

**日志骨架**：当前目标 → 已有证据 → 缺口信息 → 下一步动作 → 风险处理

## Env

**职责**: 纯信息记录，不做校验、不执行命令。

Agent 自行用 bash/kubectl/read 采集环境状态，通过 `env({ scope, data })` 写入会话日志。Consequence 直接在消息历史中搜 env tool call 获取上下文。

**Scope 分类**:

| scope | 采集内容 |
|-------|---------|
| `system` | OS、架构、发行版、用户、shell、node 版本 |
| `k8s` | 集群、上下文、命名空间、配置、服务端版本 |
| `git` | 分支、远程、状态、最新提交、领先/落后 |
| `file` | 路径、是否存在、大小、类型、权限、import |
| `project` | 根目录、包管理器、脚本、依赖、构建系统 |

**待优化**:
- 模板引导：env 输出当前 scope 的采集清单
- 结构化 data：V2 按 scope 定义推荐字段
- 自动聚合：consequence 自动扫描所有 env 调用合并为 envSummary

## Consequence

**职责**: 执行前的风险评估，委托独立子模型推理。

**输入**:
```
proposedAction { operation, target, details? }
context { envSummary? }
```

**输出**:
```
{ risks[], decision, rationale, envNeeded? }
```

**模型**: 调用 `@earendil-works/pi-ai` 的 `complete()`，偏好 claude-sonnet-4，fallback 到最便宜可用文本模型。与主 agent 解耦，不影响主对话上下文窗口。

**判定**: `proceed`（风险可控）| `caution`（先处理风险）| `abort`（不执行）

**待优化**:
- 规则引擎兜底已知风险，减少子模型调用
- 与 env 联动，自动合并 envSummary
- 子模型结果缓存，相同操作短时间不重复
- 高风险操作建议向用户确认
