---
origin: idea
status: accepted
created: 2026-09-17
---

# Intent: pi-events-daemon

## Problem

Agent 需要等外部条件（推理服务就绪、MR 合并、CI 通过、ticket 关闭、长任务完成）才能继续。现有手段各有结构性缺口：

- **bg_run** 只检测"进程退出"一种事件，其余条件必须手写轮询脚本包进去；任务 session-scoped（session 关闭即杀、通知不可达），只唤醒 launching session。
- **pi-poll** 已把"shell 条件轮询"做好，但它是**前台阻塞**调用——等 30-60 分钟的服务启动会占死整个 turn，没有通知唤醒，也不能跨 session/跨项目。

实测证据（speculative-training 3 个 session，65 次 bg_run）：29 次（45%）是纯"等待条件"任务，每个新实例手写一份 probe 脚本（`wait_glm51.sh` 等），同一等待最多 relaunch 5 轮。多 session 协作时，session A 关心的 MR/CI/ticket 事件无法被 session B 感知，进度盘点靠逐 session 调 reckon。

## Proposed outcome

一个中心化常驻事件 daemon（pi extension 提供 tool）：agent 声明式订阅"某条件变为真"——MR 合并、CI pipeline/job 终态、ticket 关闭、HTTP 200（sglang 实例就绪）、语料处理完成、任意自定义脚本或命令。daemon 按可插拔判定器轮询判定，触发时经 pi 机制唤醒订阅 session；同时支持主动查询当前状态。判定语义继承 pi-poll 的 check 契约，并升级为 k8s probe 式 pass/fail/waiting 三态。跨 session 发布/订阅：一个 session 发布的 MR/ticket 事件可被另一个 session 订阅。这是 pi-workflow 报告 §5.4"中心化 daemon"设想的落地，reckon 盘点可演进为其查询侧。

## Constraints

- 通知必须能唤醒订阅的 pi session（复用 bg_run 的 durable notification + follow-up turn 模式）
- 中心化单实例 daemon，不是每 session 一个
- 判定器可插拔：允许 agent 指定脚本或命令，daemon 负责调度与结果解释
- 参考并尽量复用 bg_run 的实现模式（output + metadata、通知契约）与 pi-poll 的 check 契约
- 投递必须 durable：事件/订阅落盘，投递带 ack，未 ack 补投（2026-09-17 实测 bg_run 丢通知 7/58≈12%，metadata 却记 notified:True）；架构参考 k8s controller-runtime 对不可靠 listener 的补救思路（workqueue 重试/去重、level-trigger 状态、resync 补投），裁剪为单机最小子集，不照搬全套 informer/indexer 机械
- MVP 判定器全都要：自定义命令/脚本 + HTTP + GitLab MR/CI/ticket；服务就绪类由前两类覆盖
- MVP 需支持跨 session 事件订阅

## Open questions

- 判定器接口契约：exit code / stdout 如何映射 pass/fail/waiting 三态？（sharp）
- 跨 session 通知投递通道：pi extension 的事件机制 vs herdr peer 通信？（sharp）
- daemon 进程形态与状态存储：怎么起、活多久、订阅存哪？（sharp）
- 订阅生命周期：session 退出后订阅保留还是取消？（sharp）
- GitLab 判定器：glab 轮询 vs webhook；repo/remote 解析与凭证？（sharp）
- 与 pi-poll 的合并/共存：daemon 化后 pi-poll 前台场景保留还是吸收？（unsharp）
- reckon 集成：daemon 作为跨项目状态事实源，盘点查询怎么接？（unsharp）
