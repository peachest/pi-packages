# DDD 建模工件

本目录存放 pi-events-daemon 的领域驱动设计（DDD）建模产出——各 ddd-* skill 的分析结果
Consolidated 形态。**正典源**：词汇表 = [../CONTEXT.md](../CONTEXT.md)（22 词 + _Avoid_ 反术语）、
边界决策 = [../adr/](../adr/)（ADR 0001-0005）、裁定流 = GitHub #29（已收口）/ #30（v2 spec 增量）。
本目录不复制正典，只做按 skill 维度的结果归档与指针。

## 目录结构

| 文件 | 内容 | 状态 |
|---|---|---|
| `scope/0000-positioning.md` | 问题/价值陈述、现有插件缺口论据、目标 4 / 非目标 7、约束与假设 | ✅ 完成（#29 定位裁定） |
| `discover/0000-event-stream.md` | 事件流表（9 步仅 1 领域事件）、5 条异常路径、热点、歧义清账 4 条 | ✅ 完成（#30 A 节） |
| `subdomains/0000-core-classification.md` | 能力清单 10 项、Core/Supporting/Generic 分类、核心域声明、kernel 试金石 | ✅ 完成（ADR 0005 交叉验证） |
| `contexts/0000-context-directory.md` | 单一限界上下文判定 + 三模块层 + 防腐层 | ✅ 完成（ADR 0005） |
| `contexts/0001-term-conflict-audit.md` | 术语冲突审计 3 处处置 + 语言演进规则 | ✅ 完成 |
| `contexts/0002-boundary-adrs.md` | ADR 0001-0005 索引（一句话决策 + 链接） | ✅ 完成 |
| `aggregates/0000-aggregate-directory.md` | 三聚合 + RunnerSlot（runtime 非聚合）+ 事务边界 + 不变量索引 | ✅ 完成（#29 T10） |
| `domain-interactions/0000-domain-events.md` | 单一事件族 Transitioned、集成契约、幂等与重放 | ✅ 完成 |
| `domain-interactions/0001-services-repos-factories.md` | 三内部组件、仓储语义契约、工厂、订阅者与副作用 | ✅ 完成 |
| `model-review/0000-critic-and-readiness.md` | design-critic 两轮质询收口、回溯触发状态、实施就绪判定 | ✅ 完成 |

## 建模链状态

DDD 技能链全部完成（执行顺序如实记录——战术链先行，战略链作为验证补跑）：

```
ddd-scope ──→ ddd-aggregates ──→ ddd-domain-interactions ──→ design-critic 两轮质询
                                                                        │
     ddd-subdomains + ddd-contexts（战略验证补跑）←── ddd-discover（补跑，歧义清账）
                                                                        ↓
                                                          全部收敛 → v2 汇总 spec（#30）
```

与 kube-nodexpu-manager（5 限界上下文）不同，本项目经 ddd-contexts 验证为
**单一限界上下文**：kernel 拥有全部语言，profile 只填充值（详见 `contexts/0000`）。
这不是链没走完，是被判定的边界形态——战略层的 Core≈kernel 交叉验证（`subdomains/0000`）
与 ADR 0005 的 kernel 试金石互为印证。

## 可视化资产

五张已验收图 + 决策包（渲染级几何检查通过）：
`~/tmp/showme-ddd-aggregates.html`（聚合模型）、`~/tmp/showme-scenario-modeling.html`（场景×建模对照）、
`~/tmp/showme-sequence-subscription.html`（订阅生命周期时序）、`~/tmp/showme-domain-interactions.html`
（交互总装）、`~/tmp/showme-decision-pack.html`（裁定决策包）。绘图由 Diagram/Html Drawer
peer session 承接（html-render-check 验证闭环）。
