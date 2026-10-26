# ddd-subdomains：核心域分类与 kernel 试金石

> 正典：ADR 0005 风险节。执行日期 2026-09-18。战略层结论：**Core ≈ kernel**，与代码边界互为印证。

## 能力清单（10 项，从聚合/事件流/裁定集提取）

| # | 能力 | 关联不变量/事件 |
|---|---|---|
| 1 | 实体状态机（转换即事件、自转换 contentIdentity） | I1、Transitioned |
| 2 | 订阅模型（模板实例化、on 谓词、origin 编址、fetch/谓词分离） | I5、I7、I8 |
| 3 | 投递语义（parked/drain、两段式 ack、退避/dead-letter） | I9、I10 |
| 4 | probe 调度（RunnerSlot、tick、RunLedger、single-flight） | I5′ |
| 5 | checker 执行面（shell 三态、超时/并发/token-pattern） | ADR 0004 |
| 6 | profile（GitLab/k8s/镜像/文件：状态机+schema+模板） | — |
| 7 | key generator（URL→EntityRef） | ADR 0002 |
| 8 | session-locator adapter（v3/v4/lane/撕裂尾行） | I9 验证面 |
| 9 | 持久化（SQLite+FTS5、单写者、flock） | 事务边界 |
| 10 | 读侧查询（states/query/reckon/billboard） | — |

## 分类（Core ≤ 1/3 ✓：1/8 能力组）

| 能力组 | 类型 | 理由 | kernel 归属 |
|---|---|---|---|
| **1+2+3 语义**（I1/I5/origin 编址/parked-drain） | **Core** | 产品本身——"事件底座语义"是现有工具都没有的差异化 | **= kernel 本体** |
| 6+7 profile + key generator | Supporting | 必要非差异化，可替换、预期高频演进 | 不进 kernel；模板协议接口归 kernel |
| 10 读侧 reckon | Supporting | 价值承载，纯读侧组合 | kernel 读接口 |
| 4 调度机制 | Generic | pi-schedule 已有 run ledger/single-flight 模式（#28 复用）；槽键**语义**是 Core，tick/ledger 机制是 Generic | 语义在 kernel，机制复用 |
| 5 checker 执行面 | Generic | shell 单原语 + 常规防护，标准件 | kernel 执行器 |
| 8 adapter | Generic | 纯集成，系于 pi 私有格式，C1 降级 | 独立模块 |
| 9 持久化 | Generic | SQLite/flock/单写者标准件 | kernel 存储层 |

## 核心域声明

- **价值**：跨 session 的事件底座——转换即事件、一次抓取 N 方感知、离线跨天兑现
- **边界**：上表 Core 行；一切源系统知识出界
- **衡量指标**：通知 token 占用比、等待 turn 节省、采纳率（pi-events-doctor R4 观测）、跨天兑现率（drain 成功/应投）
- **风险**：语义蔓延（滑向编排）、adapter 私有格式漂移（pi-events-doctor R6）
- **演进**：Core 冻结慢变，profile 生态扩张

## kernel 试金石（ADR 0005 验收标准）

**新增一个 profile（如 GitHub 源）= 零 kernel 改动**。依赖单向：profile → kernel，kernel 永不 import profile。实现中 kernel 因"支持新源系统"而改 = 边界划错回溯信号。变更频率预期倒挂：profile 高频、kernel 低频。
