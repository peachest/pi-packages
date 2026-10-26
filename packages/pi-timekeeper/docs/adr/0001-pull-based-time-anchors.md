---
status: accepted
---

# 时间锚采用拉式注入，永不使用 timer 或 system prompt

pi 0.80.7 因 prompt cache 失效移除了 system prompt 中的日期（#6621）——本地/离线推理下一次全量 prefill 的代价是小时级的，这条红线不可逾越；此后 agent 完全没有时间感知。我们决定：时间锚只在 run 边界（`before_agent_start`）按节流条件（日期变更 / 间隔到期）拉式计算注入，**不引入任何 timer、不触碰 system prompt**；错过的 interval 合并为一条（no-catch-up），压缩后强制重锚。

## Considered Options

- **timer + sendMessage 推式**（#42 报告最初建议）：能覆盖长 run 中途刷新，但引入 timer 生命周期、队列去重（C3）、idle 唤醒语义三套机制；被 #45 裁定否决。
- **system prompt 注入**：正是 #6621 修掉的 bug，绝对禁止。
- **`context` 事件 per-turn transient 中途补**：可消除长 run 冻结（实测 ceiling 7.12h），但每 turn ~20 token 持续开销；#45 裁定 v1 不做，留作升级路径。

## Consequences

- 结构性保证：无 run 就无注入，空闲会话永不被时间事件唤醒。
- 已知盲区：无边界拉伸段内锚冻结（实测最长 7.12h，含午夜跨日写错日期风险），接受并以冻结上限度量，实测不满足再启用升级路径。
- customType 常量与消息形状按 C8/C10 钉死（`timekeeper.environment` / `timekeeper.state`），为 v2 迁移（CustomEntry + entryProjector）保持形态稳定。
