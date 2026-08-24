# 可提取模块分析

> 对 `pi-mypackage` monorepo 的架构审查，识别可从各 package 中提取为独立共享模块的部分。
>
> 创建日期：2026-07-23

---

## 当前已提取

| 包 | 说明 |
|---|---|
| `pi-i18n-utils` | i18n bridge 工厂，已被 pi-wishlist、pi-proxy 复用 ✅ |

---

## 1. TUI 渲染工具集 — `pi-tui-render`

**重复最严重的地方。** 三处各自实现了同样的概念：

| 功能 | pi-wishlist `ui/render.ts` | earth-online-changelog `engine/` | pi-tui (外部) |
|---|---|---|---|
| 可见宽度 | — (用 pi-tui) | `canvas.ts: visibleWidth()` | `visibleWidth` ✅ |
| 文本填充 | `pad()` | `canvas.ts: padRight(), centerPad()` | `truncateToWidth` |
| 边框绘制 | `frame()` | `box.ts: boxTop/Sep/Bottom/Line/Center/Spacer` | — |
| 卡片子框 | — | `card.ts: cardTop/Line/Divider/Bottom` | — |
| 分割线 | `divider()` | `section.ts: sectionHeader, innerDivider` | — |
| 选中行 | `selectedLine()` | — | — |

**问题**：`pi-wishlist` 的 `frame()` 和 `earth-online-changelog` 的 `box*()` 做的是**同一件事**（画带边框的盒子），但 API 风格不同（theme-aware vs 纯文本）。`visibleWidth` / `padRight` 在 earth-online-changelog 里重新实现了一遍，而 pi-wishlist 又从 pi-tui 导入。

**建议**：提取为统一的 `pi-tui-layout` 包，提供 theme-aware 的 `Box`/`Card`/`Divider`/`SelectedLine` 组件，兼容纯文本和 theme 两种模式。

### 涉及文件

- `packages/pi-wishlist/src/ui/render.ts`
- `packages/earth-online-changelog/src/engine/canvas.ts`
- `packages/earth-online-changelog/src/engine/box.ts`
- `packages/earth-online-changelog/src/engine/card.ts`
- `packages/earth-online-changelog/src/engine/section.ts`

---

## 2. Inline Edit 引擎 — `pi-tui-inline-edit`

`pi-wishlist/src/ui/inline-edit.ts`（~150 行）是一个**完全自包含的文本编辑引擎**：

- 光标按字符/单词移动（←→、Alt+←→、Ctrl+A/E）
- 插入、删除（Backspace、Delete、Ctrl+U 清行）
- Kitty CSI-u 编码解码
- 纯函数，除 `isPlainSearchInput` 外无外部依赖

**提取价值**：任何需要 TUI modal 内文本输入的包（搜索框、编辑器、输入框）都需要这套逻辑。目前只被 pi-wishlist 使用，但 `footerHint` 中 `edit-note`、`add-note` 等 mode 表明这是通用需求。

**建议**：作为独立包 `pi-tui-inline-edit`，或并入 `@earendil-works/pi-tui`。

### 涉及文件

- `packages/pi-wishlist/src/ui/inline-edit.ts`
- `packages/pi-wishlist/src/ui/types.ts`（`InlineEditState`, `InlineEditChar` 类型）

---

## 3. Key-binding 调度器 — `pi-tui-keybind`

当前模式（pi-wishlist `wishlist-view.ts` 中重复 20+ 次）：

```ts
if (matchesKey(data, "escape")) { ... }
if (data === "\r" || data === "\n" || matchesKey(data, "enter")) { ... }
if (matchesKey(data, "up")) { ... }
if (matchesKey(data, "down")) { ... }
```

**问题**：

- `data === "\r" || data === "\n" || matchesKey(data, "enter")` 这种 fallback 链到处复制
- 没有 centralized keymap，每个 handler 手写 if-else 瀑布
- mode 切换（list/search/edit-note/...）与按键处理耦合在一起

**建议**：提取声明式 keybinding 调度器：

```ts
const keymap = defineKeymap({
  "escape": () => mode === "edit" ? cancelEdit() : close(),
  "enter":  confirm,
  "up":     () => moveCursor(-1),
  "down":   () => moveCursor(+1),
  "/":      enterSearch,
}, { mode }); // mode-scoped overrides
```

### 涉及文件

- `packages/pi-wishlist/src/ui/wishlist-view.ts`（20+ 处 `matchesKey` 调用）

---

## 4. 原子化 JSON 文件 I/O — `pi-fs-utils`

**重复模式**（至少 4 个包）：

| 包 | 代码 |
|---|---|
| pi-wishlist `data/wishlist.ts` | `writeFileSync(tmp) → renameSync(tmp, path)` + `mkdirSync(recursive)` |
| pi-insight `facet-generator.ts` | `writeFile(tmp) → rename(tmp, path)` + `mkdir(recursive)` |
| pi-proxy `proxy.ts` | `existsSync → mkdirSync` 重复 **4 次** |
| pi-json-output `main.ts` | `mkdir(recursive) → writeFile` |

**建议**：提取 `pi-fs-utils`：

```ts
atomicWriteJSON(path, data): Promise<void>  // tmp+rename，自动 mkdir
readJSON<T>(path, fallback): T              // ENOENT 安全
ensureDir(path): void                       // 去重 existsSync+mkdirSync
```

### 涉及文件

- `packages/pi-wishlist/src/data/wishlist.ts`
- `packages/pi-insight/src/facet-generator.ts`
- `packages/pi-insight/src/extractor.ts`
- `packages/pi-proxy/proxy.ts`
- `packages/pi-json-output/src/main.ts`

---

## 5. Debug 日志器 — `pi-debug-logger`

`pi-wishlist/src/data/debug.ts` 是一个干净的 env-gated logger，但硬编码了 `WISHLIST_DEBUG`。每个包都会需要自己的版本。

**建议**：参数化提取为 `pi-debug-logger`：

```ts
const debug = createDebugger("wishlist"); // reads WISHLIST_DEBUG
debug("checker", "fetch failed", err);
// [12:34:56.789][wishlist:checker] fetch failed {...}
```

### 涉及文件

- `packages/pi-wishlist/src/data/debug.ts`

---

## 6. Extension 数据目录规范 — `pi-data-dirs`

各包硬编码 `~/.pi/agent/...` 路径：

| 包 | 路径 |
|---|---|
| pi-insight `dirs.ts` | `~/.pi/agent/extensions/pi-insight/` |
| pi-wishlist `wishlist.ts` | `~/.pi/agent/data/wishlist/` |
| pi-insight `dirs.ts` | `~/.pi/agent/sessions/`、`~/.pi/agent/run-history.jsonl` |

**建议**：提取 `pi-data-dirs`：

```ts
extensionDataDir("pi-wishlist")   // ~/.pi/agent/data/pi-wishlist/
extensionStateDir("pi-insight")   // ~/.pi/agent/extensions/pi-insight/
sessionsDir()                      // ~/.pi/agent/sessions/
```

### 涉及文件

- `packages/pi-insight/src/dirs.ts`
- `packages/pi-wishlist/src/data/wishlist.ts`
- `packages/pi-proxy/proxy.ts`

---

## 7. Extension 脚手架/样板 — `pi-extension-helpers`

每个包的 `main.ts` 都有重复的 boilerplate：

- `export default function(pi: ExtensionAPI)`
- `pi.on("session_start", ...)` 注册
- `pi.command(...)` slash 命令注册
- `sendDisplay(pi, content)` → `pi.sendMessage({ content, display: true })`（pi-wishlist 和 earth-online-changelog 各自定义了一份）

**建议**：薄封装层减少样板，提供 `registerCommand`、`sendDisplay`、`notify` 等便捷方法。

### 涉及文件

- `packages/pi-wishlist/src/main.ts`
- `packages/earth-online-changelog/src/main.ts`
- `packages/pi-insight/src/index.ts`
- `packages/pi-proxy/proxy.ts`
- `packages/pi-thefuck/index.ts`

---

## 提取优先级矩阵

```
高价值 │  ① TUI 渲染工具集    ② Inline Edit 引擎    ③ Key-binding 调度器
       │  (重复最多)          (通用性强)             (减少 if-else 瀑布)
       │
       │  ④ 原子 JSON I/O     ⑤ Debug 日志器
       │  (4个包重复)         (每个包都需要)
       │
低价值 │  ⑥ 数据目录规范       ⑦ Extension 脚手架
       │  (路径硬编码)         (样板代码)
       └──────────────────────────────────────────
         低实现成本              高实现成本
```

**推荐顺序**：④ → ⑤ → ⑥（这三个实现简单、风险低、立竿见影）→ ① → ② → ③（TUI 相关，需要协调 API 设计）→ ⑦
