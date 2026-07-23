# pi-wishlist — 设计文档

## 动机

`pi search` 能找到很多 package，但有些功能还不够成熟或不急于安装。生态缺少被动跟踪机制——不安装就无法收到更新通知。灵感来自 Steam 愿望单：关注感兴趣的包，有变动时自动通知。

## 设计哲学（借鉴 Steam）

**4 种事件触发 + 冷却期 + 过滤**：
- 产品发布 / ≥20% 折扣 / Demo 发布 / EA→1.0
- 同游戏 2 周内不重复通知
- 用户可配置通知类型
- 趋势数据每天 T+1 更新

pi-wishlist 采用 **事件驱动 + 每日检查** 策略。

## 里程碑

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| 一：基础设施 | 数据模型、npm/GitHub 采集、检查引擎、slash 命令、CLI | ✅ |
| 二：交互式 TUI | `/wish` 模态窗口、启动通知、npm 搜索 | ✅ |
| 三：独立 CLI TUI | `pi-wish` 独立 TUI 命令 | ✅ |
| 四：收尾打磨 | 边界情况、文档 | ✅ |
| 五：Custom UI | 内联编辑、视口管理、键盘统一 | ✅ |

## 架构决策

- **ADR-0001**: 本地 JSON 存储（`~/.pi/agent/data/wishlist/wishlist.json`）
- **ADR-0002**: 拉取式通知检查（非推送），session_start 时异步触发
- **ADR-0003**: npm ↔ GitHub 自动关联（输入 npm 包名，自动获取 GitHub 数据）

详见 `docs/adr/`。

## 数据存储

```
~/.pi/agent/data/wishlist/wishlist.json
```

## i18n

可选集成 `@juicesharp/rpiv-i18n`，支持 `/languages` 切换语言。未安装时回退英文。详见 `.scratch/i18n-integration/PRD.md`。
