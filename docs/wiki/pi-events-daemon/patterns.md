# patterns — 根因级条目

格式沿用 `~/skills/wiki/README.md`：状态 open / absorbed-into-spec / closed。

## P-001 bg_run 通知静默丢失的根因链
- 状态: absorbed-into-spec（#17 → #18 决议）
- 现象: speculative-training 3 session 实测 7/58 通知丢失；task metadata 记 `notified: True`，transcript 里却无 `custom_message` 条目
- 根因: ①`notified` 在发送**前**置 true（pi-background-tasks `extension.ts:219`）②`sendMessage` fire-and-forget，rejection 被 `agent-session.js:2012` 吞 ③bg_run 的 followUp+triggerTurn 分支中，通知条目仅在触发 turn 的 `message_end` 时落盘——turn 被 abort / provider 报错 / session 关闭竞争时永不写入
- 推论: 发送 ≠ 送达；唯一真相 = 目标 session 文件里出现条目（ack-by-verification）
- 去向: #18 决议 8（两段 ack：accepted 停高频重试 → verified 才算 delivered）

## P-002 fire-and-forget 是生态常态，不是 bg_run 独有
- 状态: absorbed-into-spec
- 现象: herdr 下行 = PTY 注入（模拟打字，无回执，5s 生命周期兜底）；pi-subagents 的 ack 终点 = `sendMessage` 返回 true 即删 result 文件（`result-watcher.ts:574-578`），turn abort 场景仍有丢失窗口
- 推论: 生态内没有现成的"verified 才算送达"；daemon 的两段式是差异化点，但 pi-subagents 的 delete-after-ack 重试循环 + dedupe/TTL + batcher 值得照抄
- 去向: #19 comment（复用机制清单）；delivery 调研附录

## P-003 手写轮询是 agent 的默认等待行为
- 状态: absorbed-into-spec
- 现象: ①speculative-training 65 次 bg_run 中 45% 是"手写轮询脚本包进 bg_run"，同一等待最多 relaunch 5 轮 ②全量扫描：前台 sleep/kill -0 轮询循环 75 次/13.9h（最长 8002s）、`sleep N; tail` 阶梯 101 次/3.1h ③pi-poll 已解决的问题仍在以原始形态出现——采用率不足
- 推论: 判定器 = shell check 是对的抽象（五类 check 覆盖全部场景）；长等待必须后台化且结果可信，否则 agent 宁可前台死等
- 去向: #19 测试矩阵（task-exit/log-line/port-200/k8s-ready/CI-terminal）

## P-004 跨天弃置调用 = 离线订阅+补投的直接价值证据
- 状态: absorbed-into-spec
- 现象: 30 次 >2h 的前台调用，结果次日~数日后才落盘（最长 63.5h smoke test）——用户放弃后台化，直接让 turn 挂着过夜
- 推论: "挂上订阅 → 关终端 → 次日 session_start 排空收结果"替代"开着终端过夜"
- 去向: #18 决议 4（持久订阅）、#19 场景清单

## P-005 代理 env 丢失是长任务失败的首要外因
- 状态: open（daemon 无法根治，但事件证据能加速定位）
- 现象: pip install 错误率 15%（153 次）、nerdctl pull 24%、nerdctl build 22%；失败模式集中为 NO_PROXY/http_proxy 丢失后重试
- 推论: 事件的 evidence 全文留存（FTS5）让这类失败可被跨 session 检索，喂给诊断

## P-006 事件通知必须边沿触发
- 状态: absorbed-into-spec（#19 原型抓出）
- 现象: 原型初版条件持续为真时每个 tick 重发事件（11 条重复）
- 推论: level-trigger 评估 + edge-trigger 通知（verdict 变迁才发事件）——controller-runtime 语义的自然推论，但 #18 决议未明说，**spec 必须显式写**
- 去向: #19 决议 1

## P-007 大 payload 指针化，索引归 daemon 自有
- 状态: absorbed-into-spec
- 现象: context-mode 实证三层阈值（intent+>5KB → 章节窗口；>100KB → 纯 pointer；否则 inline）；其 FTS5 schema 的 UNINDEXED 列天生带 `event_id/session_id/timestamp`
- 推论: drain evidence >2KB 截断 + `evidenceRef` 指针 + `evidence(notificationId)` 按需取全文；`event_chunks` FTS5 虚表建在 **daemon 自己的 store.db**（信任边界+生命周期要求），不调用 ctx_\* 工具、不用 context-mode 的库
- 去向: #19 决议 3/4

## P-008 多 session 订同一事实 = 一份判定器
- 状态: absorbed-into-spec
- 现象: 用户主场景"session A 订自己 MR，session B 也订同一个 MR"；初稿误写为"A 发布 B 订阅"
- 推论: checker 按 topic 共享（省略 check=复用、相同=合并、**不同=报错拒绝**——一个事实不得被两个判定器分裂）；publish 是次路径（省 herdr prompt 往返 token）
- 去向: #18 决议 6

## P-009 fork = 新身份，订阅不继承
- 状态: absorbed-into-spec（实证）
- 现象: pi fork 的 session 文件头 `id` 为全新 UUID，仅存 `parentSession` 指针
- 推论: inbox 编址按 UUID 天然正确；fork 要继续盯同一事实 → 重订同 topic（checker 共享零开销）；血统查询留 fog
- 去向: #18 决议 7

## P-010 中心化常驻 daemon 在 pi 生态无先例，但有两个半个
- 状态: absorbed-into-spec
- 现象: 10+ 扩展全部进程内随 session 存亡；唯一独立 daemon 先例 nemo-relay（手动启动/端口锁/HTTP）；`schedule.create`（持久 schedule + catchUp）是离线补投的半个先例
- 推论: 惰性拉起无先例可抄也无坑可踩；flock+socket 是标准解；herdr 的 env 发现（`HERDR_SOCKET_PATH` → `PI_EVENTS_SOCK`）+ JSON-RPC 单行协议直接照抄
- 去向: #18 决议 1/2/5；#21 调研

## P-011 多 remote 是常态，host/project 必须由 agent 显式填
- 状态: absorbed-into-spec
- 现象: HAMi 项目有三个 remote（internal/github/hyxfork）；初稿推荐的"extension 从 git remote 自动解析"在多 remote 下有歧义；/tmp 脚本场景干脆没有 remote
- 根因: cwd → 项目不是函数（一个目录可指向多个远端事实源）
- 推论: GitLab 判定器模板把 host/project 作为占位参数由 agent 填；daemon 不做 remote 解析、不做凭证逻辑（glab 登录态是前置条件）；凭证引用统一 `$(glab config get token --host <host>)` 由 check 运行时自解析——顺带规避明文 token 进命令行的历史事故模式（P-005 同源）
- 去向: #20 决议 3/4

## P-012 订阅与状态注册表是两种模式，不合并
- 状态: absorbed-into-spec
- 现象: #24 branch 状态机讨论中暴露混淆——"等 MR merged"（订阅）与"哪些 branch 活跃"（查询）被当作同一需求
- 根因: 订阅=通知模式（per-agent、一次性、等事实成立）；注册表=现状模式（事实持久存在、任意 session 任意时刻可查）。reckon 的痛点全在后侧
- 推论: 事件/订阅管通知，states 表管现状查询；states 是一等业务数据，与 #23（遥测 out-of-scope）不冲突；泛化只到 schema（entityType/entityKey/status/payload），迁移逻辑留在模板层 checker 安装链
- 去向: #25 决议 1/2/4

## P-013 浅调研"无影响"结论关闭研究票的教训
- 状态: open（过程教训，作用于后续所有研究票）
- 现象: #27（harness v2）浅调研结论"存储地基已铺、coding-agent 未接线、无时间表"→ 关成 watch item；随后外部文章揭示 v2 设计稿含 lane 模型/意图-结果配对/fx:Effects 等对 daemon 设计直接可抄的思想，全部漏掉
- 根因四条：①浅调研被框定为影响检查（"今天会不会坏"），答案空间不含"有什么可学" ②#9000 引用了"lane-based"关键词但未追踪 ③只搜 GitHub issues+本地 dist+main 分支树，设计稿在 harness-v2/j4 分支且未做 web 搜索 ④watch 重启条件只锚"对我们有影响"单维度
- 推论: ①浅调研关闭研究票前必须回答"主设计文档/一手源读了没有"——没读到一手源就关闭=把 ignorance 写进账本 ②被引用但未展开的关键词（如 lane-based）是最高优先级的追踪线索 ③watch 条件双维度：影响维度（会不会坏）+ 启发维度（有没有值得学的）④上游出现重量级设计稿的迹象（PR 群落/CHANGELOG 大改）本身就是研究信号
- 去向: #27 重启条件已更正为双维度；fx:Effects 等收割成果见 #29 外部验证 comment

## P-014 术语单一来源——禁止为已有概念发明第二套名字
- 状态: open（写作纪律，作用于 spec/issue/HTML/CONTEXT 全部产物）
- 现象: 设计推进中出现同一概念多名并存——scope 被称"债主"、sourceSessionId 被称"紧地址"、Delivery 投递记录被称"收据"、runner 槽键被称"抓取键"、checker 替换（close+open）被称"换装"、subscribe(check) ad-hoc 路径被称"逃生舱"
- 根因: 解释性回复中为求生动引入隐喻，隐喻随后泄漏进裁定记录与图表
- 推论: ①术语只用字段名和已裁定词汇（GLOSSARY.md 词汇表为准）；解释概念 = 展开已有名字的定义，不是再造新名词 ②每引入新名词先问"它和现有名字是不是同一个东西" ③描述性用语（兜底/fallback、tech debt、行为描述）不算概念命名，不受此约束 ④存量：#26 冻结正文内"换装"两处在 spec 增量时统一替换为"checker 替换（close+open）"
- 去向: memory lesson 已存；本条为 wiki 侧纪律
