# 0009: 事件 dock 与 bg dock 不共用骨架，只对齐交互姿势

**日期**: 2026-10-19　**状态**: Accepted　**来源**: 票 45（#110）共用评估条款

## 决策

pi-events-daemon-extension 的事件 dock（registerShortcut → `ctx.ui.custom` overlay 面板 →
`setStatus` footer hint）**独立实现，不与 pi-background-tasks 的 bg dock 共用面板骨架或
组件层**；两者只对齐交互姿势。快捷键让位：bg dock 默认 `shift+down`，事件 dock 默认
`ctrl+alt+e`（`dockShortcut` 依赖可改/`null` 关闭），默认无冲突。

## 为什么不共用

- **包边界**：pi-background-tasks 是外部 npm 发布包（`~/.pi/agent/npm` 安装链），与本仓
  无依赖关系。共用骨架要么引外部包为依赖（反向拉入一个大而全的后台任务包），要么抽
  第三个共享 UI 包（为一个面板建发布/版本协调成本）。
- **面板语义不同构**：bg dock 是任务注册表的本地快照（stop/rerun 动作、输出 tail）；
  事件 dock 是 daemon 远端状态的只读投影（query op 拉取、沿驱动刷新、无写动作——cancel
  走 9 op 工具面）。动作面差异大，抽出的"共用组件"只剩一个空壳列表。
- **数据通道不同**：bg 任务状态在 extension 进程内；daemon 订阅状态经 socket op 拉取 +
  transitioned 沿广播驱动刷新。刷新模型（沿驱动 vs 本地 registry 回调）没有可复用的代码。

## 后果

- 两个 dock 快捷键/命令并存：`shift+down|ctrl+alt+b`（bg）/ `ctrl+alt+e` + `/events-dock`（events）。
- 交互习惯一致（底部 overlay、q/esc 关闭、footer hint 常驻段），用户零学习成本。
- footer 状态位分键共存：票 46 三态连接状态用 `setStatus("pi-events", …)`，dock 订阅计数
  段用 `setStatus("pi-events-dock", …)`，互不覆盖。
- 若未来出现第三个同构 dock，再评估抽共享组件层（届时三个实例才够抵消抽象成本）。
