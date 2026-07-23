# Roadmap

**源**: `.scratch/`（本地 markdown issue tracker）

## 已完成

- **format-v1**: 配置目录结构与数据加载、Patch Notes 渲染引擎、Widget 单行显示、Festival API 集成
- **format-v2**: 版本号格式、头部/Footer 渲染、卡片布局、活动板块、世界更新、编年史、和平日、Schema 扩展（6 个子 PRD 均完成，2026-06-02）

## 待实现

### format-v3 — 统一渲染引擎与排版修复

**父 PRD**: `.scratch/format/format-v3/PRD.md` — `ready-for-agent`

将 notes-renderer.ts 迁移到统一的渲染引擎（Engine 化），修复右边框不对齐等排版问题。

| 子 PRD | 状态 | 内容 |
|--------|------|------|
| prd-01 | ready-for-agent | 渲染引擎核心：canvas/box/section/card |
| prd-02 | ready-for-agent | 外框容器 + Header/Footer Engine 化 |
| prd-03 | completed | 活动卡片 Engine 化 |
| prd-04 | ready-for-agent | 世界更新板块 Engine 化 |
| prd-05 | ready-for-agent | 编年史/概要/预告/促销 Engine 化 |

### improve/v1 — 拆分 notes-renderer 大单体

**源**: `.scratch/improve/v1/` — `ready-for-agent`

将 1257 行的 `notes-renderer.ts` 拆分为 6 个职责独立的文件（date-utils、event-status、content-compute、section-render、patch-notes-orch、yaml-loader）+ 17 个 issue。
