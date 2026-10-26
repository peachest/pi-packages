# ddd-scope：定位裁定

> 正典：#29 定位裁定（issuecomment-5726276126）+ [intent/pi-events-daemon.md](../../../../intent/pi-events-daemon.md)（2026-09-17 用户确认）

## 问题陈述 / 价值陈述

**问题**：多 session 并行开发时，跨 session 的状态感知只有点对点 prompt 一条路——广播一次状态变化，每个 peer 都要各消费一份全量 prompt；接收方离线即丢；长任务的等待仍靠发起 session 手写轮询、占用对话上下文。

**价值**：把"谁在什么时候关心什么实体"从对话中抽出来——session 订阅一次，daemon 统一抓取、转换即事件、一次抓取广播 N 方、离线 parked 补投，让**等待**和**感知**不再消耗任何 session 的 token。

## 现有插件缺口论据（定位核心）

| 现有工具 | 缺口 |
|---|---|
| herdr + multi-agent-collab | herdr 无广播原语；用 N 次 prompt 模拟广播 = 每 peer 一份全量 prompt + 发布方须预知全部编址；无结构化事件语义/幂等去重；peer 关闭即丢 |
| bg_run / pi-subagents 通知 | 通知绑定发起 session 生命周期，关闭即丢（T1 实测 12%）；不跨 session |
| 手写 sleep 轮询 | 每次轮询烧发起方 token；N session 关心同一实体 = N 份重复抓取；跨天弃置（实测 30 例，含 63.5h） |
| pi-poll | 轮询发生在每 session 各自进程，无跨 session 去重，无离线语义 |
| reckon skill | 状态靠 agent 记忆，无权威登记处，可能答过时信息 |

一句话：现有工具是"会话通道"（message passing），缺"事件底座"（broker + 登记处）。

## 目标（4 条，含边界）

1. **中介事件广播**——发布 O(1)，订阅方收极小通知（notificationId + evidenceRef）；边界：只广播实体转换事件
2. **离线可靠**——parked 不重试不超时，SESSION_START drain 兑现；边界：可靠到"会话终有一日启动"
3. **共享抓取**——槽键 (EntityRef, 模板) 唯一化外部访问；边界：只去重读，不缓存判定语义
4. **非事件状态登记**——branch/worktree/MR 生命周期可查询，/reckon 点查询；边界：登记≠指挥

## 非目标（7 条）

1. 不存储凭证（零凭证**存储**不是安全边界；check 运行时自取 glab 登录态）；不做 sandbox 级隔离——执行面清单见 spec 增量（B3）
2. 不做编排/leader 派活（8 月实验失败；只感知不指挥；演进预留 bg_* 集成须重新裁定边界）
3. 不做通用消息队列（事件是转换副产品 I1；>2KB 走 evidenceRef）
4. 不执行副作用工作（checks are probes，ADR 0004）
5. 不替代 harness-v2 runtime lane（外挂 adapter）
6. 不对源系统特判（profile 模板 + check 抽象）
7. 诊断/telemetry 后置（风险登记由 pi-events-doctor skill 承接，事后批量诊断）

## 约束与假设

| 约束/假设 | 可验证性 | 验证方式 |
|---|---|---|
| 单实例 flock + 单写者 SQLite | 可验证 | 崩溃矩阵 X1-X5 |
| harness 消息 v3/v4 双形态 | 可验证 | adapter 启动自检（C1） |
| 会话存储可被 adapter 扫描（MVP: JSONL 双形态 + lane 信封透传 + 撕裂尾行容错；SQLite 后端 = SQL 查询预案） | 可验证 | 测试层级 A/B/C |
| agent 愿意订阅而非手写轮询 | 不可验证（行为假设） | pi-events-doctor R4 观测 |
| 长连接活性可区分长忙/已关 | 可验证 | socket 探活 + #26 L84 |

风险登记：见 intent「Risks」节 + [../../../../../skills/in-progress/pi-events-doctor/references/risks.md](https://github.com/)（本地 ~/skills/in-progress/pi-events-doctor/）。
