# 地球在线 (Earth Online Changelog)

> English · [中文文档](./README.zh.md)

**一个 Pi 扩展，每天在终端为你推送"地球 Online"更新公告。**

## 这是什么？

每次打开 Pi（或手动输入 `/earth`），你会看到"地球 Online"的版本更新——仿佛现实世界是一款在线游戏：

```
## 🌍 地球在线 v2026.06.01
📅 2026-06-01

━━━ ✨ 版本亮点 ━━━
儿童节活动开启，童心加成 buff 上线！

━━━ 🎯 新增活动 ━━━
- 🎮 **儿童节活动正式开启**
  所有玩家获得童心加成 buff，登录即送限定头像框！

━━━ 🛍️ 促销 & 限时 ━━━
- 🛒 **京东 618 活动正在预热**

━━━ 📅 即将到来 ━━━
- 06-18 🛒 京东 618 大促正式开启
```

## 功能特性

- **每日自动触发** — 每天首次启动会话时自动显示更新公告
- **斜杠命令** — 随时输入 `/earth` 查看今日更新
- **节日 API** — 从公开 API 自动获取节假日信息
- **多语言支持** — 自动检测 Pi 的语言设置（中文/English）
- **小组件** — 在编辑器小组件区域显示紧凑的单行摘要
- **分类展示** — 事件按 🎯 新增活动 / 🛍️ 促销 & 限时 / 🔧 系统更新 分组
- **未来事件预览** — 显示未来 7 天的事件预告
- **版本亮点** — 特殊日期展示 ✨ 版本亮点 横幅

## 安装

复制到 `~/.pi/agent/extensions/` 或 `.pi/extensions/` 然后重载：

```bash
cp -r earth-online-changelog ~/.pi/agent/extensions/
# 或用符号链接：
ln -s $(pwd)/earth-online-changelog ~/.pi/agent/extensions/earth-online-changelog
# 在 Pi 中执行：
/reload
```

## 使用方法

```
/earth            — 显示今天的"地球在线"更新公告
```

## 数据格式

事件配置按 `config/YYYY/MM.yaml` 目录树组织。扩展在每次启动时加载当日对应的文件。

### 目录结构

```
config/
├── 2026/
│   ├── 01.yaml   （一月）
│   ├── 02.yaml   （二月）
│   └── ...
└── 2027/
    └── ...
```

### 月度文件格式

每个 YAML 文件定义该月的所有事件：

```yaml
entries:
  - date: "2026-06-01"
    tag: "儿童节"
    highlight: "儿童节活动开启，童心加成 buff 上线！"
    events:
      - name: "儿童节活动正式开启"
        type: seasonal
        icon: "🎮"
        section: events
        names:
          zh: "儿童节活动正式开启"
          en: "Children's Day Event Now Live"
        descriptions:
          zh: "所有玩家获得童心加成 buff，登录即送限定头像框！"
          en: "All players receive a Childlike Heart buff! Log in to claim a limited avatar frame!"
```

### 字段说明

| 字段 | 层级 | 说明 |
|------|------|------|
| `date` | entry | 完整日期 YYYY-MM-DD |
| `tag` | entry | 可选标签，如"儿童节" |
| `highlight` | entry | 可选版本亮点说明 |
| `events[]` | entry | 当日事件列表 |
| `name` | event | 显示名称（默认语言） |
| `type` | event | seasonal / promotion / limited / recurring / special |
| `icon` | event | Emoji 图标 |
| `section` | event | 所属更新公告版块：events / promotion / system |
| `names` | event | 多语言名称映射（zh, en） |
| `descriptions` | event | 多语言描述映射（zh, en） |

### 版块映射

| `section` 值 | 中文版块 | English section |
|-------------|----------|-----------------|
| `events` | 🎯 新增活动 | 🎯 New Events |
| `promotion` | 🛍️ 促销 & 限时 | 🛍️ Promotions |
| `system` | 🔧 系统更新 | 🔧 System Updates |

来自 API 的节日事件自动分配到 `events` 版块。

## 贡献数据

欢迎添加新的节假日、促销或趣味事件！

1. 找到对应的 `config/<year>/<month>.yaml` 文件
2. 按照上述格式添加条目
3. 提交 PR

## 空白日

如果某天没有事件，扩展会显示：

```text
🌍 地球在线 v2026.06.01 — ✨ 平凡的一天 ✨
```

```text
🌍 Earth Online v2026.06.01 — ✨ An ordinary day ✨
```
