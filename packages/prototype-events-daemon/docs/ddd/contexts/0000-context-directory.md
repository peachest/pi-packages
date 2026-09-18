# ddd-contexts：上下文目录与术语冲突审计

> 正典：ADR 0005（单一限界上下文）。执行日期 2026-09-18（战略验证补跑）。对照 kube-nodexpu-manager 的 5 BC 形态，本项目判定为**单一限界上下文 + 模块层**——profile 若各自成上下文就会有独立统一语言，而 #29 裁定恰好相反：profile 只提供 State **值**和模板，概念全部 kernel 所有。

## 上下文目录

**pi-events-daemon = 1 个限界上下文**，内部三层模块 + 一组运行时组件：

| 层 | 职责 | 非职责 | 语言归属 |
|---|---|---|---|
| **kernel** | Entity/Subscription/Delivery 三聚合、事件、投递语义 | 零领域知识（不对源系统特判） | **拥有**全部核心术语 |
| **profile** | 每实体类型知识：状态机定义、payload schema、key generator、probe 模板 | 不发明新概念 | 借用 kernel 语言，只填充值 |
| **session-locator adapter** | 会话存储形态识别（v3/v4/lane/撕裂尾行） | 不解释通知语义 | 借用 + 自有技术词（transcript/lane envelope） |
| **runtime 组件**（probe 执行/投递循环/验证扫描） | 连接组织，重启重建 | 不裁定转换、不进词汇表 | 实现层概念（A2 裁定） |

**防腐层（ACL）**：profile 的 key generator + probe 模板——GitLab URL → EntityRef（ADR 0002）、glab/kubectl 查询 → 三态 verdict。外部上下文：GitLab/k8s/harness/pi 会话存储。

## kernel 试金石

见 [../subdomains/0000-core-classification.md](../subdomains/0000-core-classification.md)：新增 profile = 零 kernel 改动；依赖单向 profile → kernel。备选方案"profile 各自上下文"被否决（翻译成本买不到东西——profiles 真实共享 substrate 语言）。

## 数据所有权与一致性

三聚合各自单根（A1 裁定：Delivery = 单行根聚合）；跨聚合只用 EntityRef 引用（I6）+ TransitionIntent（意图，非共享状态）+ outbox。无跨聚合 join，读侧组合归查询服务。

## 语言演进规则

1. 新名词过"是否同一概念"审计（P-014），通过才进 CONTEXT.md
2. 裁定 comment 中的临时表述以 CONTEXT.md 为准，裁定落定即同步词条
3. enum 值 / key 前缀一律全称（`project | user`、`external/`）
