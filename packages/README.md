# Packages — Deep Modules

每个 `packages/<name>/` 是一个**深模块**（deep module）：小接口背后藏大量行为。

## 布局约定

```
packages/<name>/
  index.ts        ← 入口（公共面）。包外只能 import 这个（或其他根文件）
  <name>.ts       ← 另一个入口（包可以暴露多个小入口，不要一个巨型 barrel）
  lib/            ← 私有实现（包外不可 import，lint:boundaries 强制）
  tests/          ← 同位测试 + fixtures（也是私有子目录）
```

**公共面 = 包根文件**，不是单一 index.ts。实现放 `lib/`、测试放 `tests/` 只是惯例——规则是按深度判定的：**任何子目录都是私有的**，所以新增目录永远不需要改配置。加入口 = 加根文件。

## 四条规则（lint:boundaries 强制，全部 error）

1. **入口边界**：包外代码（根/其他包）只能 import 包的根文件，不能进子目录
2. **包内自由**：包内文件互相 import 不受限
3. **测试走入口**：`tests/` 只能 import 任何包的入口 + 自己 `tests/` 的 fixtures，不能深导入任何包内部（连自己的也不行）；跨包集成测试 OK，深导入不行
4. **无环**：禁止依赖循环

## 运行

```bash
npm run lint:boundaries   # dependency-cruiser 扫 packages/
npm run check             # lint:boundaries + tsc --noEmit
```

**不要写 barrel 文件**（把整个子树经一个 index re-export）——暴露多个小入口，实现藏进子目录。

复制 `packages/example/` 作为新包模板（该包同时是规则咬合的活证明）。
