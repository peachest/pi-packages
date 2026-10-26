# 0007: 值序列化边界归 store 持久层

**日期**: 2026-10-19　**状态**: Accepted

## 决策

凡"wire 形态 ≠ SQLite bind 形态"的值（on 数组、thresholds、schedule、payload），序列化/反序列化一律在 store 的 SQLite 实现层（bind 前 stringify、rowTo* parse）。kernel 与 memory store 只见 wire 原形态。

## 为什么

首次生产使用（2026-10-19，speculative-training 战役）发现 adhoc subscribe `on: ['failed']` 崩 SQLite param-11——首修在 kernel 侧 stringify（8a8403b），复核裁定归属 store 层：同文件 thresholds/schedule/payload 先例全部在 store 层做，on 是唯一例外违反"序列化边界与持久化引擎绑定"原则；memory store 不应承担 SQLite 形态知识。

## 后果

- 新增 wire≠bind 形态的字段时，序列化写进 sqlite.ts 的 put*/rowTo* 对，不进 kernel
- memory store 保留 wire 原形态（测试断言 wire 语义，不关心 SQLite 串）
- `SubscriptionRow.on` 类型对齐 wire（string | string[]）；读侧消费（onMatches）兼容 JSON 串还原
