# prototype-viz — PROTOTYPE, throwaway

> **设计问题（一句话）**：不 fork pi，纯 extension 层能否在 TUI 内**自包含**地跑通 Codex-Visualize 式闭环（远程开发友好，全程不出终端）？
>
> `/viz` → transcript 内嵌 Unicode 盒线架构图（任何终端可渲染，中文 OK）→ `ctrl+g` overlay 实时预览节点 → 生成**高亮替换卡片** + agent 追问回合。

## 设计变更记录（v2）

- v1 用 file:// 链接引导浏览器打开 HTML —— 远程开发下链接指向 host 文件，本地打不开；且"在浏览器看"违背"TUI 内展示"的诉求。**v2 移除 HTML/链接，一切在终端内。**

## 要验证的三件事

1. `registerEntryRenderer` 内嵌 Unicode 盒线图（+ kitty/iterm2 终端时附加 Image PNG）是否可用
2. `ctx.ui.custom({overlay:true})` + SelectList + **onSelectionChange 实时细节预览**是否顺畅
3. 下钻选中 → 高亮替换卡片 + `pi.sendUserMessage()` 触发真实 agent 回合

## 用法

```
/viz <任意主题>      # 生成可视化卡片（Unicode 架构图；kitty/iterm2 终端额外显示 PNG）
/vizdrill 或 ctrl+g  # overlay：↑↓ 移动实时预览细节，enter 生成高亮替换卡片并注入 agent 追问
```

- 节点/细节为词表假数据，按主题 hash 确定性生成（同主题 → 同布局，替换卡片布局不变、仅高亮）
- ASCII 图冒烟测试：`.scratch/viz-smoke.test.ts`（CJK 双宽对齐已验证）
- entry 持久化进 session JSONL（含 pngBase64，每条几十 KB）——原型可接受

## 结论（测完回填）

- [ ] Q1 Unicode 盒线图内嵌：待验证
- [ ] Q2 overlay 实时预览下钻：待验证
- [ ] Q3 高亮替换卡片 + follow-up 回合：待验证
