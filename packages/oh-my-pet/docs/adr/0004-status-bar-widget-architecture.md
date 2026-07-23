# 状态栏 Widget 架构

状态栏的格式化逻辑不分散在各适配层中重复实现，而是集中在核心框架的 Widget 引擎中。每个 Mod 可注册自定义 Widget，用户可通过配置自由组装状态栏。

## 决策

### 1. Widget 引擎：Core 提供基础设施，Mod 注册 Widget

Core 框架提供 Widget 引擎（注册表 + 渲染管线 + 默认 Widget 集），Mod 通过 `pet.registerWidget()` 向目录注册新 Widget。适配层只负责将框架产出的字符串数组渲染到平台特定接口（`setStatus()` / shell echo）。

```
Core Widget 引擎                    Mod（装备 Mod）
┌──────────────────────┐           ┌──────────────────┐
│ 默认 Widget:          │           │ registerWidget(   │
│  speciesIcon          │  ←───    │   "equipmentIcon",│
│  level                │           │   { render, ... } │
│  fullnessBar          │           │ )                 │
│  vitality             │           └──────────────────┘
│  expProgress          │
│  lastFed              │
│  snapshotAge          │
│                       │
│ 渲染管线:              │
│  formatStatusLines()  │
│  → string[]           │
└──────────────────────┘
         ↓
  适配层: ctx.ui.setStatus(lines[0])
```

### 2. Widget 注册时机

Widget 与 Effect 共享相同的生命周期约束——**仅在声明阶段调用 `registerWidget()`**。`seal()` 后注册表冻结，渲染管线成为纯查表 + 模板拼接。

### 3. Widget 接口

```typescript
interface PetWidget {
  readonly id: string;                    // 唯一标识，如 "speciesIcon"
  readonly displayName: string;           // 面板中的可读名称
  readonly category: string;              // "core" | "equipment" | "ability" | ...
  
  // 渲染。返回 null 表示该 widget 当前不可见（如无 git 仓库时隐藏 git widget）
  render(state: PetState, config: WidgetConfig): string | null;
}

interface WidgetConfig {
  rawValue?: boolean;    // 只显示值，不含标签（如 "3" 而非 "Lv.3"）
  maxWidth?: number;     // 截断最大宽度
}

interface PetState {
  attributes: Record<string, number>;  // { "core.exp": 2400, "core.fullness": 80, ... }
  species: string;                      // "fox"
  level: number;                        // 从 core.exp 派生
  lastFedAt: number;                    // 最近一次喂食时间戳
  snapshotAge: number;                  // 最近一次 compact 距今秒数
}
```

Widget 接收完整 PetState，自行选取所需字段——与 ccstatusline 的 `render(item, context, settings)` 模式一致。

### 4. 配置持久化

两级配置，项目级覆盖全局：

- **全局默认**：`~/.config/agent-pet/statusline.json` — 用户级默认布局
- **项目覆盖**：`.pet/statusline.json` — 项目特定布局，覆盖全局

查找顺序：项目配置 → 全局配置 → 框架内置默认。

### 5. 多行支持 + MVP 默认

框架渲染管线返回 `string[]`（每行一个字符串），不限制行数。MVP 默认配置为单行，匹配 PRD 格式：

```json
{
  "lines": [
    {
      "widgets": [
        { "type": "speciesIcon" },
        { "type": "level" },
        { "type": "fullnessBar" },
        { "type": "vitality" }
      ]
    }
  ]
}
```

用户可通过编辑 `.pet/statusline.json` 新增行或重新排序 Widget。

## 备选方案

**格式化逻辑留在各适配层中。** 已拒绝：PRD 的状态栏格式 `[🦊 Lv.3] ████████░░ 80% ⚡fast` 是纯映射（属性 → 字符串），与平台无关。分散到各适配层导致格式变更需改 N 处，新增适配层需重复实现。

**Core 导出纯函数 `formatStatusBar()` 而非 Widget 引擎。** 已拒绝：该方案不支持 Mod 注入 Widget。当装备 Mod 引入 `equipmentIcon` 时，Core 的纯函数无法感知。

**Widget 可在运行阶段动态注册。** 已拒绝：与 `registerEffect` 一致，声明阶段注册确保渲染管线的查表操作在 seal 后稳定。

## 影响

- 适配层接口从"格式化 + 渲染"收缩为"平台特定输出"——接口面积显著缩小
- 格式变更只需改一处 Widget 的 render 实现
- 新增适配层（如 VS Code）仅需实现 `display(string[])`，零格式化代码
- 装备/技能 Mod 可携带自己的 Widget，与 Core Widget 并列在目录中
