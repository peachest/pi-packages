# ADR-0003: npm 驱动的 GitHub 自动关联

**状态**：已采纳  
**日期**：2026-06-23（从现有代码追溯）

## 背景

愿望单支持两种包来源标识：`npm:<name>` 和 `git:github.com/owner/repo`。为了展示 GitHub 数据（star 数、fork 数、推送时间），需要将 npm 包映射到对应的 GitHub 仓库。

## 决策

从 npm registry 的 `/latest` 端点返回的 `repository.url` 字段自动解析 GitHub 仓库地址。不支持用户手动指定 npm ↔ GitHub 映射。

## 权衡

| 选项 | 优点 | 缺点 |
|---|---|---|
| **npm repository.url 自动解析** | 零配置，用户只需输入包名；数据源单一可信任 | 依赖 npm registry 的 repository 字段准确性；部分包的 repository 不是 GitHub 或无此字段 |
| **用户手动指定映射** | 灵活，覆盖 npm 字段缺失的场景 | 增加认知负担；需要额外的 CLI 参数或 UI 操作 |
| **自动解析 + 手动覆写（折中）** | 覆盖最全面 | 接口复杂化，收益不大——缺少 GitHub 的包仍可正常显示 npm 数据 |

## 后果

- 添加包时自动追踪，结果（含 GitHub 数据）异步保存在 `WishlistEntry.sources` 中
- 部分包可能永远没有 GitHub 数据（如私仓或非 GitHub repo），只展示 npm 数据
- 如果 npm repository.url 格式非标准，正则可能解析失败，该包跳过 GitHub 数据