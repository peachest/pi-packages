# 回溯触发清单（正式门禁评分）

> 本文档是 `ddd-model-review` 流程（阶段 IV 质量门禁）的输出之一。
> 根据评分结果逐条检查五条回溯阈值，防止无限循环。同一回溯路径最多 3 次。

## 五条阈值逐条判定

| 触发条件 | 当前状态 | 是否触发 | 说明 |
|---|---|---|---|
| **聚合边界与上下文边界矛盾** → ddd-contexts | 三聚合（Entity/Subscription/Delivery）全部位于单一限界上下文内（ADR 0005）；RunnerSlot 为 runtime 非聚合（A2 裁定，aggregates/0000 显式标注）；跨聚合只用 EntityRef（I6）+ TransitionIntent（意图非共享状态）+ outbox；contexts/0000 与 subdomains/0000 "Core ≈ kernel" 交叉验证互证。未发现任何不变量或聚合关系跨越上下文边界 | ❌ **不触发** | 边界得分 9.0/10；唯一缝隙是 I2 强制机制未写明（问题 I-01），属文档补全而非边界矛盾 |
| **术语冲突率 > 20%** → ddd-contexts | 未处置的同名不同义/同义异名/定义漂移 **2 处**（I-02 ephemeral key 公式漂移、I-05 Transition/TransitionEvent 双形），已处置 3 处（contexts/0001 审计表）+ 槽键 interval 经 critic B1 裁定后当前工件一致（CONTEXT.md "(EntityRef, template)" 与 aggregates/0000、B1 收口 comment 三方一致）。冲突率 = 2 ÷ 18 正典词条 = **11.1%** | ❌ **不触发**（临界） | 11.1% < 20%，但距阈值不远——I-02/I-05 必须在 v2 汇总 spec 写作前清账，否则新增衍生词（#30 B 节 op 面重审）会推高比率 |
| **不变量表达率 < 60%** → ddd-aggregates | I1-I10 逐条按 rubric（显式=1/部分=0.5/未表达=0）：I1=1、I2=1、I3=0、I4=0.5、I5=0.5、I6=0.5、I7=1、I8=1、I9=0.5、I10=1 → **7.0/10 = 70%** | ❌ **不触发**（贴线） | 70% ≥ 60%。低分主因与 example-npu-manager 初评同构：I5/I9 的强制点在 runtime 非聚合组件（A2 **有意裁定**，非设计缺陷）、I3 是负向边界声明、I4/I6 缺具名强制点——补强制点归属是一句话级文档工作，不需要重开聚合设计。若后续把 I3 重述为可校验断言或给 I4/I6 补归属，表达率即达 85% |
| **集成模式与上下文映射不一致** → ddd-context-map（本项目单上下文，以 ADR 0005 ACL 节代位） | ADR 0005 ACL 节：key generator（URL→EntityRef，ADR 0002）+ probe 模板（glab/kubectl→三态 verdict）构成对外部上下文（GitLab/k8s/harness/pi 会话存储）的防腐层；domain-interactions/0000 集成契约（Notification 值对象自描述、契约 owner = daemon 单方、session 纯消费者）与单上下文判定一致；adapter SessionStore 只读契约（domain-interactions/0001）与 ACL 语义一致。无不一致点 | ❌ **不触发** | #30 B 节挂账项（op 审计、provenance post-MVP、wake 备份通道）均为 v2 spec 增量清单内容，不构成映射矛盾 |
| **事件完整性 < 70%** → ddd-domain-interactions | 按 substrate 自身正典判据（T10 收口裁定 ①②，#29 issuecomment-5728518782）：领域事件目录覆盖 **1/1**（Transitioned 正式定义含源聚合/触发条件/字段/范围，自转换同族 ADR 0003）；主路径 9 步命令→聚合处理映射 **9/9**；异常路径 5/5 有状态机归宿（Delivery state 封闭集 + 退避/dead-letter 终态 + 幂等 re-push）。**判"substrate 合理形态"而非"完整性缺口"**——论证见 0001 维度 4 专项：状态=纯归约模型下，Delivery/Subscription/Session 簿记按定义不产生事件（CONTEXT.md Delivery state 词条 "never produces events"），不存在被漏定义的领域事件；残余缺口是异常路径表 12 个过去时命名无性质标注（I-06，呈现层 P3） | ❌ **不触发** | 若按"每簿记步都需事件"计才会低于 70%，但该判据直接推翻 T10 用户裁定的正典地位，属判据错置 |

## 触发回溯决策

| 回溯目标 | 触发 | 执行内容 | 时间估计 |
|---|---|---|---|
| ddd-contexts | ❌ 不触发 | — | — |
| ddd-aggregates | ❌ 不触发 | — | — |
| ddd-context-map（ADR 0005 ACL 节代位） | ❌ 不触发 | — | — |
| ddd-domain-interactions | ❌ 不触发 | — | — |

**本轮零回溯。** 全部 6 个问题（0002 清单）均为正典同步/呈现层缺口，随 v2 汇总 spec 写作清账即可，无需重跑任何 ddd 环节。

### 定点回溯预案（仅当未来复查中以下条件成立时启用，当前不执行）

- 若 v2 spec 写作中发现 I-01 的依赖反转机制无法在"kernel 零领域知识"下自洽 → 定点重跑 **ddd-contexts**（只重审 ADR 0005 模块层的语言归属表，预期修正：要么显式引入校验器注入协议，要么承认校验器归 profile 侧、kernel 收到的是校验结果）
- 若 #30 B 节 op 审计新增 ≥2 个未处置术语冲突使冲突率破 20% → 定点重跑 **ddd-contexts** 的术语审计步（0001 增补行，预期修正：新词过 P-014 入册或显式豁免）

## 无限循环保护

同一回溯路径执行限制（上限 3 次）：
- ddd-contexts：0 次
- ddd-aggregates：0 次
- ddd-context-map：0 次
- ddd-domain-interactions：0 次

**无任何路径达到 3 次限制。** ✅

## 校验清单

- [x] 五条阈值逐条判定，触发/不触发明确
- [x] 每条判定引用具体工件与量化依据
- [x] 事件完整性争议项给出单边论证（不 triggers，判据指向 0001 专项节）
- [x] 无限循环保护已检查（全部 0 次）
- [x] 定点回溯预案含重跑范围与预期修正（当前均不执行）
