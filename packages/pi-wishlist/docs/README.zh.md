# pi-wishlist

> English · [中文文档](./README.zh.md)

Pi 包愿望清单——跟踪你感兴趣但尚未安装的包，并在有新版本或活动时自动通知。

## 安装

```bash
pi install pi-wishlist
```

如需多语言支持，同时安装 i18n SDK：

```bash
pi install npm:@juicesharp/rpiv-i18n
```

安装后，使用 `/languages` 切换可用语言。
当未安装 i18n SDK 时，wishlist 显示英文。

## 使用

### 在 Pi 对话中

```
/wish             TUI 愿望清单界面
/wish add <name>   添加包到愿望清单
/wish list         列出愿望清单
/wish remove <name> 移除包
/wish refresh      强制检查更新
/wish stats <name> 查看详细统计
```

## 功能特性

- **事件驱动通知** — 新版本发布 / GitHub 活动时自动推送
- **每日自动检查** — session_start 时异步检查，非阻塞
- **npm ↔ GitHub 自动关联** — 只需输入 npm 包名，自动获取 GitHub 数据
- **自动移除已安装包** — 安装后自动从愿望清单移除
- **去重通知** — 每个事件仅通知一次
- **TUI 模态界面** — `/wish` 打开交互式愿望清单
- **i18n 就绪** — 可选 `@juicesharp/rpiv-i18n` 支持语言切换

## 数据存储

`~/.pi/agent/data/wishlist/wishlist.json`

## License

MIT
