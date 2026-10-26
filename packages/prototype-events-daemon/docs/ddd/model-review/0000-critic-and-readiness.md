# model-review：design-critic 质询收口与实施就绪

> 本项目的 model-review 环节由 **design-critic peer session（两轮独立质询）+ ddd-discover 歧义清账**承担，替代标准评分表。全部质询记录：`~/tmp/pi-events-daemon-critique.md`（第一轮）、`~/tmp/pi-events-daemon-critique-round2.md`（第二轮）。

## 第一轮（2026-09-17）：8A / 8B / 3C

| 级 | 代表项 | 处置 |
|---|---|---|
| A1 聚合形态 | Delivery 单行根 + Notification 值对象换位 | 接受，图同步 |
| A2 RunnerSlot | runtime 非第四聚合（durable-vs-runtime 论证，harness-v2 LaneState 先例） | 接受 |
| A3 accepted 歧义 | 投递状态机补 parked；长连接活性信号区分两路 | 接受 |
| B1-B8 | interval 归模板、ad-hoc 键、执行面清单、懒重探、checks-are-probes（ADR 0004）、dead-letter、事件自描述、证据保留 30d/7d | 全接受或部分接受 |
| C1-C3 | adapter 自检降级、状态机层=profile 声明、v2 汇总 spec 升级为硬承诺 | 接受 |

## 第二轮（2026-09-18）：3A / 5B / 1 结构（针对 intent 更新）

| 条 | 处置 |
|---|---|
| A1 zero credential 措辞回归 | 接受——恢复 B3 表述 + 执行面清单归位（commit 9c351cb） |
| A2 Open questions 过时 | 接受并精确化（fs-watch 拆两档：ProbeSpec 一等构造块已裁定 / checker 层接口待票） |
| A3 publish 信任缺口 | 接受——provenance 方案落 #29 后**裁定 post-MVP**（用户决策：MVP 不考虑） |
| B4-B8 | 全接受（过度声明修正、O(1)/O(N) 维度修正、herdr 批评对象修正、lane 检测机制补全、Risks 节新增） |
| 结构 | 定位段移出 Problem，独立节 |

## 回溯触发状态

- ddd-aggregates → ddd-aggregates 回溯（事件携带他聚合私有数据）：未触发（事件自包含）
- ddd-subdomains 回溯（无法区分 Core/Supporting）：未触发（Core≈kernel 1/8 清晰）
- ddd-contexts 回溯（>5 术语冲突）：未触发（0 不可调和，见 0001 审计）
- ddd-scope 回溯（价值主张不清）：未触发

## 实施就绪判定

**就绪**。T10 设计决策全部收口（#29 已关），进入实施通道：

```
v2 汇总 spec（#30 清单全量并入）→ to-tickets → 实现 → pi-events-doctor 生产期诊断
```

遗留至实现期的显式欠账：op 审计（随 v2 spec 出表拍板）、provenance post-MVP、快照机制（性能触发）、probe 修正豁免（随 provenance）。
