# pi-wishlist — 领域词汇表

## 项目定位

pi-wishlist 是 pi 编码助手的扩展包。它让用户可以"关注"感兴趣但暂时不急于安装的 pi packages，后台自动检查更新（新版本、star 变化）并在有变动时推送通知。

---

## 词汇表

### Wishlist（愿望单）

一组被用户"关注"的 pi package 的集合。不是一个优先级队列或待办清单——它只表示"我有兴趣知道这个包的动态"。

### WishlistEntry（愿望单项）

愿望单中的单个条目。包含：
- 包的来源标识（`npm:<name>` 或 `git:github.com/...`）
- npm 和 GitHub 的数据快照
- 用户添加的个人备注（可选）
- 变更通知历史和最后检查时间
- GitHub API 的失败计数和冷却状态

### Package Source（包来源）

标识一个包来源的字符串。目前支持：
- `npm:<name>` — 来自 npm registry 的包
- `git:github.com/owner/repo` — 来自 GitHub 的仓库

通过 npm 注册信息中的 `repository.url` 自动关联 npm ↔ GitHub。

### Notification Event（通知事件）

一次检测到的变化。目前有两种类型：
- `new_version` — npm 发布了新版本
- `stars_changed` — GitHub star 数量变化

每个事件记录 `from`/`to` 和时间戳。同一事件（type + from + to）不会重复记录。总事件数上限 30 条，超出后保留最近 15 条。

### Daily Check（每日检查）

session_start 时自动触发的异步检查流程：
1. 加载愿望单
2. 检查已安装包并自动移除
3. 逐个查询 npm 版本和 GitHub 数据
4. 对比上次快照，记录新事件
5. 保存变更

同一天不会重复检查。如果检查时发现变化，通过 pi 的 widget 机制推送通知面板。

### Installed Package Removal（已安装包自动移除）

检查时扫描 `packages.json`（pi 的已安装包清单），如果愿望单中有包已被安装，自动从愿望单中移除并发送通知。这是一个"重装不自动恢复"的操作——移除后用户需要主动重新添加。

### GitHub Cooldown（冷却机制）

GitHub API 连续失败 3 次后，对该包的 GitHub 数据检查暂停 24 小时。这是对未认证 GitHub API 速率限制的被动应对策略。

### TUI Mode（终端 UI 模式）

通过 `/wish` 命令打开的交互式模态界面。所有操作（列表、搜索、添加、编辑备注、移除确认）在单个 `ctx.ui.custom()` 组件中完成，不退出到聊天界面。分为：
- **list** — 主列表视图，支持键盘导航和搜索过滤
- **add-search** — 搜索 npm registry 并选择包
- **add-note** — 添加包后的备注输入
- **edit-note** — 编辑已有备注
- **remove-confirm** — 移除确认
- **search** — 列表内的文字搜索过滤

### ⚠️ 易错点：trackPackage 结果需保存

在 TUI 内部添加包时（`add-note` → Enter），`addPackage()` 只创建空条目（`sources: {}`），`trackPackage()` 的异步结果必须通过 `updatePackage()` 写入 JSON，否则列表会显示版本 `---`、star `0`、下载 `--`。

正确做法：
```ts
trackPackage(key).then((result) => {
  const sources: Record<string, unknown> = {};
  if (result.npm) sources.npm = result.npm;
  if (result.github) sources.github = result.github;
  updatePackage(key, { sources, lastChecked: new Date().toISOString() });
}).catch(() => {});
```

而在 CLI 侧（`src/commands/add.ts`）这已经在 `handleAdd` 中正确处理了，只有 TUI 内联添加遗漏。

**另一个常见的反模式**：不要 `trackPackage(key).catch(() => {})` 不做后续保存——这样包会以空数据写入，用户必须手动按 `r` 刷新才能看到数据。

## ⚠️ 易错点：i18n key 命名不能与 locale 文件中的粒度 key 冲突

`footerHint()` 调用 `t("footer.list.a", "a add  d remove  ...")`，期望返回完整的 fallback 字符串。但 locale 文件中恰好有 `"footer.list.a": "add"`，导致 `t()` 的 locale 查找优先于 fallback，footer 行退化为只显示 `"add"`。

根本原因：新引入的 composite key 和已有的 granular key 发生了**命名碰撞**。

**原则：给 `t()` 传入带 fallback 的完整 string 时，key 名必须全局唯一，不与 locale 文件中任何已有 key 冲突。** 推荐做法：

- 如果 site 的内容是一个完整的句子/行（如 footer、通知文本），key 名用外层的目录层级（如 `"footer.list"`），不要复用子键。
- 引入新 key 前先 grep 确认 locale 文件中没有同名 key。