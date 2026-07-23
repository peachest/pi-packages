# Mod 注册接口、属性命名空间与生命周期

宠物框架通过统一 Mod 注册接口（PetAPI）加载所有 Mod——内置喂养 Mod 与第三方 Mod 无差别。属性键采用点分命名空间，Mod 生命周期分为声明与运行两个独立阶段。

## 决策

### 1. 属性键命名空间

属性键采用点分命名空间约定：`"core.exp"`、`"core.fullness"`、`"core.vitality"`。

- **MVP 分类**：`core.*` —— 宠物生存核心属性（exp、fullness、vitality）
- **Growth 预留**：`ability.*` —— 能力维度；`equipment.*` —— 装备注入属性
- **框架语义**：框架不解析点分结构，仅做字符串匹配。面板可按顶层前缀分组展示
- **binlog 兼容性**：binlog 条目直接存储完整键名。Growth 阶段引入新命名空间时，已有条目无需迁移——重放引擎的加法逻辑不变

### 2. Mod 生命周期：声明与运行阶段分离

Mod 加载后经过两个明确阶段，以框架调用 `seal()` 为分界：

```
声明阶段（Declaration Phase）         运行阶段（Runtime Phase）
─────────────────────────────        ──────────────────────────
registerEffect(name, policy)  ✅     registerEffect()        ❌ 抛出
on(event, handler)            ❌     on(event, handler)      ✅ 
pushAttributes(delta)         ❌     pushAttributes(delta)   ✅（仅已注册键）
                                     seal()                  ❌ 幂等
```

#### 2.1 声明阶段

框架按顺序加载每个 Mod：
1. 调用 `export default function(pet: PetAPI)`
2. Mod 通过 `pet.registerEffect(name, policy)` 声明其管理的属性及策略
3. 此阶段不允许调用 `on()` 或 `pushAttributes()`——调用视为错误

#### 2.2 Seal

所有 Mod 加载完毕后，框架调用内部 `seal()`：
- 冻结注册表——不再接受新的 `registerEffect` 调用
- 验证完整性——所有 MVP 阶段必须属性都已注册（`core.exp`、`core.fullness`、`core.vitality`）
- 此后过渡到运行阶段

#### 2.3 运行阶段

- Mod 通过 `pet.on(event, handler)` 订阅统一事件
- Mod 通过 `pet.pushAttributes(delta)` 推送属性增量
- 对未注册键的推送：框架拒绝并记录警告，不写入 binlog

### 3. 策略注册

`registerEffect(name, policy)` 的 `policy` 参数 MVP 阶段仅支持 `{ min: number, max: number }`。策略与键名一一绑定——`core.exp` 和 `core.fullness` 可以有各自独立的 `{min, max}`。

## 备选方案

**扁平键名（`"exp"`）。** 拒绝：Growth 阶段引入能力维度时，`"exp"` → `"core.exp"` 的迁移要么改写不可变 binlog 历史，要么在重放时引入键名翻译层——两者都增加了不必要的复杂度。点分命名空间在 MVP 阶段的额外成本为零（额外输入 6 个字符），但消除了 Growth 阶段最可能的数据迁移。

**声明与运行阶段不分离（注册和订阅可以交叉）。** 拒绝：交叉允许 Mod 在声明完成前就开始订阅事件，导致部分属性未注册状态下的竞态。分离两个阶段确保所有 Mod 的注册在事件流启动前完整。

**策略绑定到属性分类而非单个键（例如 `core.* → {min:0, max:100}`）。** 拒绝：不同属性天然需要不同边界。exp 的上界远大于 fullness（0–100 百分比），通配符策略无法表达这种差异。

## 影响

- 面板可按命名空间分组渲染：`core.*` 为常驻状态栏，`ability.*` 为能力面板，`equipment.*` 为装备详情
- 框架在 seal 时可验证 MVP 必须属性是否全部注册
- `@pi-pets/framework-api` 类型包中 `registerEffect` 签名的第一个参数为 `string`（接受任意点分键名）

## 补充决策：pushAttributes 限流策略（2026-05-26）

**框架不做限流。** 限流是 Mod 的游戏逻辑——不同 Mod 可能有不同限流策略（喂养 Mod 用 TokenBucket 防止刷屏通胀，战斗 Mod 可能不限流）。框架只提供 `responseId` 幂等保证：同一 `responseId` 重复 push 时静默忽略。

各 Mod 自行决定何时调用 `pushAttributes` 以及是否跳过某些事件。TokenBucket/LeakyBucket 等限流原语由 Mod 自行实现（约 15 行代码），不作为 PetAPI 方法暴露。
