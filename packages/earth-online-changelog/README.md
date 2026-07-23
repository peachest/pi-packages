> [中文文档](./docs/README.zh.md) · English

# 地球在线 (Earth Online Changelog)

A Pi extension that brings the "Earth Online" patch notes to your terminal every day.

## What is this?

Every day when you open Pi (or manually with `/earth`), you'll see the "Earth Online" version update — as if the real world were a live-service game:

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

## Features

- **Daily auto-trigger** — Shows patch notes on first session of the day
- **Slash command** — `/earth` anytime to see today's patch notes
- **Festival API** — Auto-fetches holiday info from public APIs
- **Multi-language** — Detects Pi's language setting (中文/English)
- **Widget** — Shows compact single-line summary in the editor widget area
- **Categorized sections** — Events grouped into 🎯 New Events / 🛍️ Promotions / 🔧 System Updates
- **Upcoming events preview** — Shows events for the next 7 days
- **Version highlights** — Notable days get a ✨ Highlights banner

## Installation

Copy to `~/.pi/agent/extensions/` or `.pi/extensions/` and reload:

```bash
cp -r earth-online-changelog ~/.pi/agent/extensions/
# Or symlink:
ln -s $(pwd)/earth-online-changelog ~/.pi/agent/extensions/earth-online-changelog
# Then in Pi:
/reload
```

## Usage

```
/earth            — Show today's Earth Online patch notes
```

## Data Format

Event configuration is split into a `config/YYYY/MM.yaml` directory tree. The extension loads the correct file for today's date on each startup.

### Directory Structure

```
config/
├── 2026/
│   ├── 01.yaml   （January）
│   ├── 02.yaml   （February）
│   └── ...
└── 2027/
    └── ...
```

### Monthly File Format

Each YAML file defines all events for that month:

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

### Field Reference

| Field | Level | Description |
|-------|-------|-------------|
| `date` | entry | Full date YYYY-MM-DD |
| `tag` | entry | Optional label, e.g. "儿童节" |
| `highlight` | entry | Optional version highlight text for this day |
| `events[]` | entry | List of events for this date |
| `name` | event | Display name (default language) |
| `type` | event | seasonal / promotion / limited / recurring / special |
| `icon` | event | Emoji icon |
| `section` | event | Which patch-notes section: events / promotion / system |
| `names` | event | Multi-language name map (zh, en) |
| `descriptions` | event | Multi-language description map (zh, en) |

### Section Mapping

| `section` value | Chinese section | English section |
|-----------------|-----------------|-----------------|
| `events` | 🎯 新增活动 | 🎯 New Events |
| `promotion` | 🛍️ 促销 & 限时 | 🛍️ Promotions |
| `system` | 🔧 系统更新 | 🔧 System Updates |

API festival events are automatically assigned to the `events` section.

## Contributing data

Welcome to add new holidays, promotions, or fun events!

1. Find the correct `config/<year>/<month>.yaml` file
2. Add entries following the format above
3. Submit a PR

## Empty day

When there are no events for a day, the extension shows:

```text
🌍 地球在线 v2026.06.01 — ✨ 平凡的一天 ✨
```

```text
🌍 Earth Online v2026.06.01 — ✨ An ordinary day ✨
```