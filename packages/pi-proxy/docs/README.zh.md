# pi-proxy

> English · [中文文档](./README.zh.md)

> 在 pi 会话中动态切换代理环境变量，无需重启。

一个 pi 扩展，注册四个斜杠命令**和四个 agent 可调用工具**实现透明的代理管理——无需退出 pi，也无需在每个 bash 命令前添加环境变量。

## 命令（用户用）

| 命令 | 说明 |
|------|------|
| `/proxy` | 启用代理注入——之后所有 bash 命令自动携带代理环境变量 |
| `/proxy-unset` | 禁用代理注入 |
| `/proxy-config` | 打开编辑器编辑 `.env` 文件（每行一个 `KEY=VALUE`） |
| `/proxy-status` | 查看当前配置和代理变量 |

## 工具（agent 用）

agent 可以直接调用以下工具来配置代理，无需请用户编辑文件或重启 session。修改后立即生效。

| 工具 | 说明 |
|------|------|
| `proxy_set` | 设置代理 URL 和/或 no_proxy 主机，立即启用注入。省略的参数保留原值，传 `""` 清除。 |
| `proxy_unset` | 立即禁用代理注入（磁盘配置保留）。 |
| `proxy_status` | 返回当前代理状态和所有环境变量。 |
| `proxy_noproxy` | 管理 no_proxy 绕过列表：添加、删除、设置或清空主机。 |

## 工作原理

代理环境变量在 spawn 层级注入——**命令文本不会被污染**。agent bash 和用户 bash（`!` 命令）都透明地接收注入的环境变量。

```
proxy.env (KEY=VALUE)
       │
       ▼
proxy.ts (extension)
       │
       ├──► spawnHook: agent bash → 静默合并 env
       ├──► user_bash: ! commands → 静默合并 env
       │
       └──► 工具: proxy_set / proxy_unset / proxy_noproxy
             更新 proxy.env + 模块状态 → 下一次 bash spawn 自动使用新 env
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
