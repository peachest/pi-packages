# State（当值维护）

## 战役快照

pi-agent-renew v0.3 已合并 main（PR #177，f8f69b7），生产在位。换届机制经三起真实事故加固后已闭环：

1. **regen-gov 第 3→4 届**（2026-10-21）：暴露 waitForIdle 竞态 → run-start 门闩 + late-ready 续办 + renew.log 持久化。
2. **lead 第 1 届 7 连败**（2026-10-27 晨）：暴露模块级状态双源（ready 直呼成功但 handler 校验失败）→ 状态机整体搬进 renew.log JSONL 事件流，尾部推导。
3. **lead 附言误拒**（2026-10-27 午）：暴露校验正则过严（`## 交接附言` 不容后缀）→ 标题容错 + ≥20 字阈值 + 校验失败先发修正指导而非 abort。

换届闭环实录：regen-gov 3→4 届、lead 1→2 届（07:39 成功，新 lead 上岗清出 15 条僵尸订阅）。

**本届（第 1 届）新增**：身份自举入（ebe94e7，.agents/agents/ 随之建成）；agent-bootstrap skill 收尾提示同步（换届已可用 + agent-session-id 纪律，~/skills a9ff4af）；身份文件首次过 gitleaks 闸门（AGENT.json 内网代理 IP 改写为指针表述——身份文件同样受 sanitize 闸门约束）。

## 本届做了什么（10-27 08:30 起第 1 届）

- 身份自举：五件套 + AGENTS.md Agents 索引节 + sessions.log 首行（be053ed→ebe94e7 推 main）
- agent-bootstrap skill 与扩展实态对齐（换届已可用提示 + sessionId 必须工具取）
- 本届换届本身 = 扩展自舁后首次由 owner 身份执行的换届

## 活跃后台任务

- 无本 session 的 bg 任务。换届机制用户侧（speculative-training）状态由其各自 STATE 维护。

## Backlog（按优先级）

1. **真实换届里程积累**：观察 spec-training 各 agent 下一轮换届，renew.log 事件流在多 agent 并发下的表现（TAKEOVER 路径尚无真实触发）。
2. **pi-events-daemon 挂载继承**（issue #147）：落地后把上岗 checklist 的「cancel+重挂」切换为「mount-inherit」——需跟踪 daemon 侧进度。
3. **e2e 补真实 TUI 路径**：现有 13 用例全部是 mock ctx 的进程内验证，TUI 的 waitForIdle/newSession 真实行为靠换届实战兜底。
4. Future（用户未拍板）：`--adopt` 接管通道、`agent-status` 命令、manifest 去重整理。

## 交接附言

**本届做了**：换届扩展全生命周期落地（SPEC §6 定稿 → 三轮事故加固 → ocr + challenge-audit → 13 用例测试套件 → PR #177 合并 main）+ 身份自举 + bootstrap skill 同步。
**未完成**：Backlog 全部原样移交（见下）。
**下一届第一动作**：Backlog 1——观察 speculative-training 各 agent 下一轮换届，重点看 TAKEOVER 路径（至今无真实触发）与 renew.log 在多 agent 并发下的表现。
**隐性知识指针**（不要重新探索）：
- 三起事故的根因/修复/用例映射 → renew.test.ts 文件头注释 + charter 红线节
- 「校验器比执行者更死板会惩罚正确工作」的教训 → 附言正则事故（07:03 lead）+ ready 双源事故，都是同一模式的两个面
- 对 agent 写提示词的规范 → writing-for-agents skill（negation 反效果/招募先验/渐进披露），renew.ts 四处文案已按此定稿
- 身份文件也过 gitleaks 闸门 → ebe94e7（AGENT.json 内网 IP 被拦实录）
- wt remove 前必须 bash pwd 验证切出 worktree → 本仓 AGENTS.md 5f8f92e（两次复发）
