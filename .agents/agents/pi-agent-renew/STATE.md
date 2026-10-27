# State（当值维护）

## 战役快照

pi-agent-renew v0.3 已合并 main（PR #177，f8f69b7），生产在位。换届机制经三起真实事故加固后已闭环：

1. **regen-gov 第 3→4 届**（2026-10-21）：暴露 waitForIdle 竞态 → run-start 门闩 + late-ready 续办 + renew.log 持久化。
2. **lead 第 1 届 7 连败**（2026-10-27 晨）：暴露模块级状态双源（ready 直呼成功但 handler 校验失败）→ 状态机整体搬进 renew.log JSONL 事件流，尾部推导。
3. **lead 附言误拒**（2026-10-27 午）：暴露校验正则过严（`## 交接附言` 不容后缀）→ 标题容错 + ≥20 字阈值 + 校验失败先发修正指导而非 abort。

换届闭环实录：regen-gov 3→4 届、lead 1→2 届（07:39 成功，新 lead 上岗清出 15 条僵尸订阅）。

## 活跃后台任务

- 无本 session 的 bg 任务。换届机制用户侧（speculative-training）状态由其各自 STATE 维护。

## Backlog（按优先级）

1. **真实换届里程积累**：观察 spec-training 各 agent 下一轮换届，renew.log 事件流在多 agent 并发下的表现（TAKEOVER 路径尚无真实触发）。
2. **pi-events-daemon 挂载继承**（issue #147）：落地后把上岗 checklist 的「cancel+重挂」切换为「mount-inherit」——需跟踪 daemon 侧进度。
3. **e2e 补真实 TUI 路径**：现有 13 用例全部是 mock ctx 的进程内验证，TUI 的 waitForIdle/newSession 真实行为靠换届实战兜底。
4. Future（用户未拍板）：`--adopt` 接管通道、`agent-status` 命令、manifest 去重整理。

## 交接附言

（本届在写）本届完成：扩展全生命周期——SPEC 定稿 → bootstrap skill → 扩展三轮事故加固（竞态/状态双源/正则过严）→ ocr 评审 + challenge-audit 复核 → 13 用例测试套件 → PR #177 合并 → lead/regen-gov 两台真实换届闭环。教训索引：wt remove 前必须 bash pwd 确认切出 worktree（AGENTS.md 5f8f92e，本仓两次复发）；对 agent 的提示词用正向陈述+招募先验（writing-for-agents），negation 会把被禁行为拉进上下文。
