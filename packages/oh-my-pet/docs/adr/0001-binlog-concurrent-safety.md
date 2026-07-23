# 多 AI Agent 并发宠物状态的 Binlog 架构

在同一个项目中运行的多个 AI Agent 会话（pi、Claude Code 以及未来的其他 Agent）需要安全且并发地向同一个宠物的状态写入数据，且不使用锁。我们选择了基于序列号和快照重放的、按会话划分的追加式 Binlog 方案。

## 备选方案

**基于读-改-写锁的共享文件。** 每次属性修改推送都需要获取锁、读取当前状态、计算并写回。被否决：并发会话之间存在锁竞争，如果某个会话在持有锁时崩溃，错误恢复会很复杂。

**无持久化的内存状态。** 被否决：宠物状态必须在会话重启后仍然存在，并且在各个 Agent 之间可见。

**基于重放的按会话 Binlog。** 每个会话写入自己的追加式文件。从最新快照开始重放所有 Binlog 即可确定性地重建当前状态。属性贡献是可加且可交换的，因此跨会话的重放顺序无关紧要。选择此方案是因为它无锁、崩溃安全（追加式写入），并且可以扩展到任意数量的并发会话。

## 重放引擎实现细化

### 纯计算核心 + 数据存储层

重放引擎本身是纯函数，不接触文件系统。在它与持久化之间引入 PetStore 接缝（数据存储层）：

```
重放引擎（纯函数）              PetStore 接缝（持久化抽象）
┌────────────────────────┐     ┌─────────────────────────┐
│ replay(allEntries,     │     │ readCheckpoint() → CP   │
│   checkpoint, registry)│ ←── │ readEntries() → Entry[] │
│   → Attributes         │     │ writeCheckpoint(cp)     │
│                        │     │ appendEntry(sid, entry) │
│ compact(allEntries,    │     │ deleteSession(sid)      │
│   checkpoint, registry)│ ──→ │                         │
│   → Checkpoint         │     │ 适配器：JSON/SQLite/内存 │
└────────────────────────┘     └─────────────────────────┘
```

### consumed 过滤在重放引擎内

PetStore 返回全量条目，不做 consumed 过滤。replay 内部根据 `checkpoint.consumed` 跳过已消费条目（`seq > consumed[sessionId]` 才处理）。consumed 的过滤、更新、清理全部在重放引擎内，单一职责。

曾考虑让 PetStore 提供 `readUnconsumedEntries(consumed)` 返回过滤后条目，已拒绝：consumed 语义拆分到两层后，后续扩展时过滤和更新容易不同步。

代价：compact 需遍历全量条目。缓解：(1) compact 仅搭载 `/compact` 触发，非热路径；(2) 会话结束时清理 binlog（见下文）；(3) MVP 阶段条目极少。Growth 阶段 compact 可独立优化，不再复用 replay 的全量遍历。

### 逐条目策略钳制

每条 binlog 条目的属性 delta 应用后立即根据属性策略钳制，而非最终一次性钳制。属性策略定义单次更新的合法范围——类比 K8s resourceSlice capacity policy 对每次申请的校验和取整。中间状态不应出现非法值。

MVP 仅实现 `{min, max}` 基础策略；Growth 阶段引入完整策略模型（`validRange` 含 min/max/step/default，`validValues` 为离散合法值集合），钳制时向上取整。策略通过 `registry` 参数传入 replay/compact。

## 影响

- 系统时钟变化不会破坏状态——排序依赖于按会话的序列号，而非时间戳
- 已结束会话的 Binlog 文件在被消费后可以清理
- 快照生成搭载在 `/compact` 上以摊平成本
- 快照之间的 Binlog 条目越多，重放成本越高；经常执行压缩可以控制这一成本
- 重放引擎可被纯函数测试覆盖——给定 Entry[] + Checkpoint + registry，产出确定的 Attributes，零 I/O
- 新增存储后端只需实现 PetStore 接口，重放引擎和 Mod 不变
- Binlog 条目数据结构：`{ sessionId, seq, responseId, timestamp, mod, attributes }`，其中 `responseId` 为幂等键（同一条 LLM response 重复推送时去重），`attributes` 为点分命名空间的增量映射（如 `{ "core.exp": +10, "core.fullness": +5 }`）
