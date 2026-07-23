# pi-proxy

> English · [中文文档](./README.zh.md)

> 在 pi 会话中动态切换代理环境变量，无需重启。

一个 pi 扩展，注册四个命令实现透明的代理管理——无需退出 pi，也无需在每个 bash 命令前添加环境变量。

## 命令

| 命令 | 说明 |
|------|------|
| `/proxy` | 启用代理注入——之后所有 bash 命令自动携带代理环境变量 |
| `/proxy-unset` | 禁用代理注入 |
| `/proxy-config` | 打开编辑器编辑 `.env` 文件（每行一个 `KEY=VALUE`） |
| `/proxy-status` | 查看当前配置和代理变量 |

## 工作原理

代理环境变量在 spawn 层级注入——**命令文本不会被污染**。agent bash 和用户 bash（`!` 命令）都透明地接收注入的环境变量。

```
. env file (KEY=VALUE)
       │
       ▼
proxy.ts (extension)
       │
       ├──► spawnHook: agent bash → 静默合并 env
       └──► user_bash: ! commands → 静默合并 env
```

## 持久化

状态存储在 `~/.pi/agent/` 下，pi 重启后恢复：

- `proxy-config.json` — 启用标志 + env 文件路径
- `proxy.env` — 环境变量（可直接编辑）

## 状态栏

```
○ Proxy off    👈 已禁用
● Proxy (http://127.0.0.1:7890)   👈 已启用
```

## 安装

```bash
pi install /path/to/pi-proxy
```

可选的 i18n 支持：

```bash
pi install npm:@juicesharp/rpiv-i18n
```

## 设计

参见 [docs/design.md](./docs/design.md) 了解架构、数据模型、边界情况和测试计划。
