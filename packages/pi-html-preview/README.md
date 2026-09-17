# pi-html-preview

`vscode_preview` pi tool：一键把文件送进 VS Code Live Preview，替代手动「ctrl+click 路径 → 点 preview 按钮」流程。Live Preview 继续负责 HTTP server 和自动刷新。

## 组成

| 部分 | 位置 | 作用 |
|------|------|------|
| pi 扩展 | `index.ts` | 注册 `vscode_preview` tool：校验文件 → TCP 发命令给 bridge → 返回结果 |
| vscode 桥接扩展 | `vscode-bridge/hyx-preview-bridge-0.0.1/` | 在 vscode 扩展宿主里监听 `127.0.0.1:39271`，收到 JSON 就 `vscode.commands.executeCommand`（`file://` 字符串参数自动转 `vscode.Uri`） |

命令映射（`buildCommand`）：
- `external`（默认）→ `livePreview.start.externalPreview.atFile` — 在本地浏览器打开（Remote SSH 端口自动转发）
- `internal` → `livePreview.start.preview.atFileString` — VS Code 内 webview 面板

## 安装

pi 侧（本仓库根目录）：

```bash
pi install ./packages/pi-html-preview
```

vscode 侧（一次性，Remote SSH 会话中执行）：

```bash
bash packages/pi-html-preview/vscode-bridge/install.sh
```

然后在 VS Code 里执行 `Developer: Reload Window`。

## 多窗口

每个窗口的 exthost 各跑一个 bridge：绑定 `39271` 失败则依次探测到 `39280`，选中端口后把 `{pid, port, workspace folders}` 登记到 `~/.vscode-server/preview-bridge-registry.json`，dispose 时注销。

tool 调用时读登记表：优先路由到「workspace 包含目标文件/cwd」的窗口；都是 loose file 时取第一个存活条目；登记表缺失（旧版 bridge）则回退固定端口。死 pid 条目在读写两侧都会被清理。Live Preview 自身的 HTTP 端口冲突由它自己处理，tool 不依赖具体端口。

## 安全

bridge 只绑定 loopback、只接受 `{command, args}` 并转发给 `vscode.commands.executeCommand`——即本机任意进程可触发本 vscode 窗口可执行的任意命令。与 shell 别名/任务等本机信任面同级，不扩大攻击面，但不要把端口暴露到非 loopback。
