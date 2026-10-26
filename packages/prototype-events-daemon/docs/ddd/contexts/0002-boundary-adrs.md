# 边界 ADR 索引（ddd-contexts / ddd-aggregates）

> 完整决策/理由/权衡/备选/风险见各 ADR 原文（[../../adr/](../../adr/)）。本文件只做索引。

| ADR | 决策（一句话） | 产生的 skill 环节 |
|---|---|---|
| [0001](../../adr/0001-aggregate-boundaries.md) | 三聚合各自单根：Entity 富聚合（TransitionEvent 内部实体）、Subscription/Delivery 单根（裁定非缺省）；禁止集合容器根 | ddd-aggregates |
| [0002](../../adr/0002-native-identity.md) | 实体原生身份：EntityRef = 源系统原生标识（URL/key 前缀 external/ project/ user/），agent 不铸造不解析，key generator 负责 | ddd-aggregates |
| [0003](../../adr/0003-content-identity-self-transition.md) | 内容身份自转换：(state, contentIdentity) 是真实转换对——digest/uid/contentHash 变化即使状态不变也发事件 | ddd-aggregates |
| [0004](../../adr/0004-checks-are-probes.md) | checks are probes：探测无副作用，副作用工作归 session 工具 | critic C 级收口 |
| [0005](../../adr/0005-single-bounded-context.md) | 单一限界上下文：kernel 拥有语言、profile 说 kernel 语言；kernel 试金石 = 新增 profile 零 kernel 改动，依赖单向 profile → kernel | ddd-contexts + ddd-subdomains |
