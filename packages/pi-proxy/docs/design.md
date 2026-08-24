# Pi Proxy Extension — 设计文档

## 概述

一个 pi extension，注册 `/proxy`、`/proxy-unset`、`/proxy-config`、`/proxy-status` 四个命令，以及 `proxy_set`、`proxy_unset`、`proxy_status`、`proxy_noproxy` 四个 agent 可调用工具，并在 footer 中展示代理状态。用于在 pi session 中动态开关代理环境变量，无需退出重启。

## 需求

1. `/proxy-config` — 打开外部编辑器编辑 `.env` 文件（逐行 KEY=VALUE），自动关闭代理
2. `/proxy` — 开启代理注入（后续所有 bash 命令自动携带代理环境变量）
3. `/proxy-unset` — 关闭代理注入
4. `/proxy-status` — 查看当前配置和开关状态
5. 开关状态跨 session 持久化
6. 启动时恢复上次的开关状态
7. agent bash 和 user_bash（`!` 命令）均注入代理环境变量
8. 命令文本不被污染，代理注入对用户和 agent 完全透明
9. Footer 实时展示代理开关状态
10. `proxy_set` 工具 — agent 直接设置代理 URL 和 no_proxy，立即保存并生效
11. `proxy_unset` 工具 — agent 直接关闭代理注入
12. `proxy_status` 工具 — agent 查询当前代理状态
13. `proxy_noproxy` 工具 — agent 管理 no_proxy 列表（增删改查）
14. 工具与命令共享同一份模块状态，工具修改后立即对后续 bash 命令生效

## 数据模型

两层持久化：

```
~/.pi/agent/
├── proxy-config.json    # 状态 + .env 文件路径引用
└── proxy.env            # 环境变量（key=value 逐行，用户可直接编辑）
```

**proxy-config.json**：

```json
{
  "envFile": "/home/peachest/.pi/agent/proxy.env",
  "enabled": true
}
```

**proxy.env**：

```
# 代理环境变量
# 每行一个 KEY=VALUE，/proxy 开启后注入到所有 bash 命令

http_proxy=http://127.0.0.1:7890
https_proxy=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
all_proxy=socks5://127.0.0.1:7891
ALL_PROXY=socks5://127.0.0.1:7891
no_proxy=localhost,127.0.0.1,.local
NO_PROXY=localhost,127.0.0.1,.local
```

初始模板（首次创建时）只保留 `#KEY=` 不含值，方便用户直接粘贴而不需要先删除占位值：

```
# http_proxy=
# https_proxy=
# HTTP_PROXY=
# HTTPS_PROXY=
# all_proxy=
# ALL_PROXY=
# no_proxy=
# NO_PROXY=
```

## 架构

```
┌──────────────┐  load/save   ┌──────────────────────┐   read on /proxy
│  proxy.ts    │ ◄──────────► │ proxy-config.json    │ ────────────────┐
│  (extension) │              │ (enabled + envFile)   │                 │
└──────┬───────┘              └──────────────────────┘        ┌────────▼────────┐
       │                                                      │   proxy.env     │
       │ spawnHook / custom ops injects env                   │  (KEY=VALUE)    │
       │ tools update proxyEnv + persist                      └─────────────────┘
       ▼
┌──────────────┐
│  bash tool   │ ──► spawn("cmd", { env: {...parentEnv, ...proxyEnv} })
│  (overridden)│
│  user_bash   │ ──► createLocalBashOperations + exec({ env: {...env, ...proxyEnv} })
└──────────────┘

┌──────────────┐
│  proxy_set   │ ──► merge params into env → persistEnv → applyProxyState → next spawn uses new env
│  proxy_unset │ ──► applyProxyState(enable=false) → next spawn has no proxy env
│  proxy_status│ ──► readCurrentEnv → return as tool result
│  proxy_noproxy│──► read/modify no_proxy list → persistEnv → update proxyEnv if enabled
└──────────────┘
```

## 实现方案

### 核心机制 1：agent bash — spawnHook

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: ({ command, cwd, env }) => ({
    command, cwd,
    env: { ...env, ...proxyEnv },
  }),
});
```

### 核心机制 2：user_bash — custom operations

```typescript
pi.on("user_bash", () => {
  const local = createLocalBashOperations();
  return {
    operations: {
      exec(command, cwd, options) {
        return local.exec(command, cwd, {
          ...options,
          env: { ...(options.env ?? {}), ...proxyEnv },
        });
      },
    },
  };
});
```

### 核心机制 3：内置编辑器 + i18n

`/proxy-config` 使用 `ctx.ui.editor()` 内置编辑器，支持 `Shift+Enter` 换行和 `Ctrl+G` 外部编辑器。

用户可见字符串通过 `@juicesharp/rpiv-i18n` 动态 import + `t(key, fallback)` 实现本地化，支持 zh/en/de/es/fr/pt/pt-BR/ru/uk。SDK 未安装时自动回退到中文 fallback。

### 共同优势

- 命令文本不被污染，env 在 spawn 时静默合并
- 闭包动态读取 `proxyEnv`，/proxy 和 /proxy-unset 修改后即时生效
- 工具与命令共享同一份 `proxyEnv` / `enabled` / `config` 状态，工具修改后下一次 bash spawn 立即使用新 env
- 外部编辑器功能完整，用户无需学新工具

### 状态管理

```typescript
let proxyEnv: Record<string, string> = {};  // 当前注入的环境变量（从 .env 解析）
let enabled: boolean = false;                // 开关状态
```

### 工具与命令的状态共享

工具和命令操作同一组模块级变量（`proxyEnv`、`enabled`）和闭包变量（`config`）。工具内部使用共享 helper 函数：

- `readCurrentEnv()` — 从 `config.envFile` 读取当前 env
- `persistEnv(env)` — 将 env 写入 `proxy.env`
- `applyProxyState(env, enable, ctx)` — 更新 `proxyEnv`/`enabled`/`config`，持久化，刷新 footer
- `formatEnvText(env)` — 格式化 env 为可读文本

`PROXY_KEY_GROUPS` 常量将工具参数映射到 env var key 组：

```typescript
const PROXY_KEY_GROUPS = {
  proxyUrl: ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"],
  allProxy: ["all_proxy", "ALL_PROXY"],
  noProxy:  ["no_proxy", "NO_PROXY"],
} as const;
```

### 生命周期

```
pi 启动
  │
  ├─► 模块加载：proxyEnv = {}, enabled = false
  ├─► i18n 注册：动态 import rpiv-i18n → registerStrings(全部 locale JSON)
  ├─► session_start：读取 proxy-config.json
  │     ├─ enabled=true → 读取 envFile 指向的 .env → 解析为 proxyEnv
  │     └─ 否则 → proxyEnv 保持空
  │
  ├─► 注册 bash tool override
  ├─► 注册 user_bash 拦截
  ├─► 注册 /proxy-config, /proxy, /proxy-unset, /proxy-status
  ├─► 注册 proxy_set, proxy_unset, proxy_status, proxy_noproxy 工具
  │
  ▼
运行时：
  /proxy-config → 确保 .env 存在（首次生成模板）
                  → 设置 belowEditor widget 显示 Ctrl+R 提示
                  → 打开内置编辑器
                  → onTerminalInput 拦截 Ctrl+R：注入 Escape 取消 → 以模板重新打开
                  → Enter 提交 → 解析保存 → 通知 → 清除 widget
                  → Escape/Ctrl+C 取消 → 不更改 → 清除 widget
  /proxy        → 读 proxy-config.json → 读 .env → 解析 → proxyEnv
                  → enabled=true → 写 config → footer "● Proxy (...)"
  /proxy-unset  → proxyEnv={} → enabled=false → 写 config → footer "○ Proxy off"
  bash/!command → 合并 proxyEnv（如果 enabled）
  /proxy-status → 读取并显示 config + .env 内容
  proxy_set     → 合并参数到 env → persistEnv → applyProxyState(enable) → 下一次 bash 生效
  proxy_unset   → applyProxyState(enable=false) → 下一次 bash 无代理 env
  proxy_status  → readCurrentEnv → 返回 tool result
  proxy_noproxy → 读/改 no_proxy 列表 → persistEnv → 如已开启则更新 proxyEnv
```

### 命令设计

| 命令 | 行为 |
|------|------|
| `/proxy-config` | 打开内置编辑器编辑 `proxy.env`。编辑器内 `Ctrl+R` 重置为模板。 |
| `/proxy-config reset` | 直接重置 .env 为初始模板，关闭代理。 |
| `Ctrl+R`（编辑器内） | 在 /proxy-config 编辑器中按下时，将内容重置为初始模板。通过 `onTerminalInput` 拦截按键，注入 Escape 取消当前编辑器，然后以模板重新打开。 |
| `/proxy` | 从 .env 读取环境变量，开启注入。 |
| `/proxy-unset` | 关闭注入。 |
| `/proxy-status` | 显示 config 状态 + .env 中的所有变量。 |

### 工具设计

| 工具 | 行为 |
|------|------|
| `proxy_set` | 合并参数到 env（省略保留、`""`清除），persistEnv，applyProxyState(enable)。返回变更摘要 + 当前 env。 |
| `proxy_unset` | applyProxyState(enable=false)。磁盘配置保留。 |
| `proxy_status` | readCurrentEnv → 返回 enabled 状态 + env 文件路径 + 所有变量。 |
| `proxy_noproxy` | 读/改 no_proxy 列表（add/remove/set/clear），persistEnv，如已开启则更新 proxyEnv。 |

**proxy_set 参数映射**:

| 参数 | 写入的 env vars |
|------|----------------|
| `proxyUrl` | `http_proxy`, `https_proxy`, `HTTP_PROXY`, `HTTPS_PROXY` |
| `allProxy` | `all_proxy`, `ALL_PROXY` |
| `noProxy` | `no_proxy`, `NO_PROXY` |

### Footer 状态展示

```typescript
ctx.ui.setStatus(STATUS_KEY, enabled ? `● Proxy (${firstUrl})` : "○ Proxy off");
```

## 文件结构

```
pi-proxy/
├── idea.md
├── DESIGN.md
├── package.json        # pi.extensions: ["./proxy.ts"]
├── proxy.ts            # extension entry
├── state/
│   └── i18n-bridge.ts  # dynamic import shim for rpiv-i18n
└── locales/
    ├── en.json         # English baseline (fallback for missing keys)
    ├── zh.json
    ├── de.json, es.json, fr.json, pt.json, pt-BR.json, ru.json, uk.json
```

通过 `pi install /absolute/path/to/pi-proxy` 加载（写入 `~/.pi/agent/settings.json` 的 `packages` 数组）。

## 边界情况

| 情况 | 处理 |
|------|------|
| 首次使用，proxy.env 不存在 | `/proxy-config` 自动生成带注释模板；`proxy_set` 直接创建文件 |
| envFile 指向的文件被删除 | `/proxy` 时 notify 文件不存在；`proxy_set` 重新创建 |
| 未配置直接 `/proxy` | notify "未配置代理" |
| $EDITOR 未设 | fallback "vim"，notify 提示 |
| .env 解析后为空 | notify 提示，不开启 |
| pi 非交互模式（-p） | 功能正常，notify/footer 为 no-op |
| `proxy_set` 无参数且 env 为空 | 返回错误提示，不操作 |
| `proxy_set` 清空所有变量 | 保存空 env，禁用注入，warning notify |
| `proxy_noproxy` add/remove/set 未提供 hosts | 返回错误提示 |
| `proxy_noproxy` 操作时代理已关闭 | 保存到磁盘，但不更新 proxyEnv（下次开启生效） |

## 兼容性

- pi >= 0.80.2
- 依赖：`@earendil-works/pi-coding-agent`（内置）、`typebox`
- 可选依赖：`@juicesharp/rpiv-i18n`（未安装时 UI 显示中文 fallback）

## 测试方案

1. `/proxy-config` → 编辑器打开 → 编辑保存 → 确认内容
2. `/proxy` → `!curl -s https://httpbin.org/ip` 验证
3. agent bash → 在 prompt 中让 agent 执行 `echo $http_proxy` 验证
4. 持久化 → `/proxy` → 退出 pi → 重启 → `/proxy-status`
5. `proxy_set({ proxyUrl: "http://127.0.0.1:7890" })` → agent bash `curl -s https://httpbin.org/ip` 验证
6. `proxy_noproxy({ action: "add", hosts: ["10.0.0.5"] })` → `proxy_status` 确认 no_proxy 已更新
7. `proxy_set({ proxyUrl: "" })` → `proxy_status` 确认 http_proxy 已清除
8. `proxy_unset` → agent bash `echo $http_proxy` 确认为空
9. 持久化 → `proxy_set` → 退出 pi → 重启 → `proxy_status` 确认状态恢复

## 不做什么

- 不做代理连通性检测
- 不做多套配置切换
- 命令描述不翻译（留原语言，rpiv-i18n 文档推荐 LLM 路由保持稳定）
