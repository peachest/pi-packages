# 三层架构：core-framework、adaptors 与 mods

宠物系统需要跨多个 AI agent 框架（pi、Claude Code 以及未来的 VS Code）工作，每个框架都有不同的事件模型和渲染界面。我们选择了三层架构：一个不依赖任何 agent 的 core-framework、每个 agent 对应的 adaptor 层，以及遵循 pi 的 `ExtensionAPI` 注册模式的宠物 mod。

## 各层职责

- **Core-framework**（`@pi-pets/core`）：agent 无关层。管理 mod 生命周期、binlog、checkpoint、属性聚合和重放。定义 adaptor 发出的统一事件 schema。
- **Adaptor 层**：每个 agent 框架一个。将 pi/Claude Code/VS Code 原生事件转换为统一事件，推送到 core-framework，渲染状态栏文本，并注册 dashboard 命令。轻量层 —— 不包含游戏逻辑。
- **Pet mods**：游戏逻辑插件。每个 mod 订阅统一事件，计算属性贡献，并将增量推送回 framework。内置喂食 mod 和第三方 mod 使用相同的 `export default function(pet: PetAPI)` 注册方式 —— 无差别。

## 曾考虑的方案

**针对每个 agent 的单体实现。** 每个 agent 各有一套完整的宠物实现。已拒绝：mod 逻辑在各 agent 间重复，没有共享状态，且每新增一个 agent 都需要完全重写。

**带有 adaptor 抽象层的 core-framework，mod 作为 pi-package。** 曾考虑但拒绝：将 mod 做成 pi-package 意味着它们接收 `ExtensionAPI`（pi 专用），这违背了 agent 无关原则。替代方案是，core-framework 充当子宿主来加载 mod 并注入 `PetAPI` —— 这与 pi 加载扩展并注入 `ExtensionAPI` 的方式类似。

## 影响

- Mod 作者基于 `PetAPI` 编写代码，该 API 在各大 agent 间保持稳定 —— 为 pi 编写的 mod 无需修改即可在 Claude Code 上运行
- 新增一个 agent 只需新增一个 adaptor 层，无需重写 mod
- `@pi-pets/framework-api` 类型包仅导出类型（类似于 `@earendil-works/pi-coding-agent`），使 framework 与 mod 保持解耦
