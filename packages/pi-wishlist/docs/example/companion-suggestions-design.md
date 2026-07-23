# pi-subagents Companion Suggestions 消息推送机制

## 概述

pi-subagents 扩展在 session 启动时自动检测推荐安装的 companion 包（pi-intercom、pi-prompt-template-model），并通过 `pi.sendMessage()` 推送一条 notification。本文档记录该机制的设计点。

## 触发时机

```ts
pi.on("session_start", (_event, ctx) => {
  resetSessionState(ctx);
  maybeSendCompanionStartupMessage({ pi, ctx, state, statuses: collectCompanionStatuses(...) });
});
```

**每次新的 pi TUI session 启动时**触发。非 TUI session（如纯 CLI 模式）跳过。

## 整体流程

```
session_start
  → collectCompanionStatuses()       状态收集
    → piIntercomStatus()             检查 pi-intercom
    → promptTemplateModelStatus()    检查 pi-prompt-template-model
  → shouldRecommend(status, "session_start")  条件过滤
  → buildCompanionStartupMessage()   构建消息文本
  → pi.sendMessage({ customType: "subagent_companion_suggestions", ... })   发送
```

## 四道防护

每次推送需通过以下检查：

| 层 | 逻辑 | 代码位置 |
|---|------|---------|
| 1. **UI 判断** | `!ctx.hasUI` → 无 UI 不推送 | `maybeSendCompanionStartupMessage()` |
| 2. **单次标记** | `state.companionSuggestionStartupShown` → 每个 session 只推一次 | `maybeSendCompanionStartupMessage()` |
| 3. **状态过滤** | `disabled / dismissed / active / surface` 任一满足 → 不推荐 | `shouldRecommend()` |
| 4. **包级细粒度** | pi-intercom 额外检查 config 是否启用、bridge 是否"需要" | `shouldRecommend()` 内特判 |

## 状态收集

`collectCompanionStatuses()` 对每个包返回一个 `CompanionPackageStatus`：

| 属性 | 含义 |
|------|------|
| `active` | 该包是否已在当前 session 生效 |
| `disabled` | 是否被配置禁用 |
| `dismissed` | 是否被用户隐藏 |
| `surfaces` | 展示表面（`session_start` / `list` / `doctor`） |
| `installCommand` | 安装命令 |
| `benefit` | 功能描述 |
| `reason` | 当前状态的原因 |

### pi-intercom 激活检测

```ts
active = hasPackageTool(pi, "pi-intercom", "intercom")         // runtime 有 intercom tool
      && intercomConfig.enabled                                 // intercom config 未禁用
      && (!bridge.wantsIntercom || bridge.piIntercomAvailable)  // bridge 需要且有
```

### pi-prompt-template-model 激活检测

```ts
active = hasPackageCommand(pi, "pi-prompt-template-model", "prompt-tool")
// 只需检查 runtime 中是否注册了 prompt-tool 命令
```

## 隐藏机制

通过 slash 命令控制：

```
/subagents-companions hide pi-intercom workspace    # 隐藏当前 workspace
/subagents-companions hide pi-intercom user         # 隐藏全局（所有 workspace）
/subagents-companions show pi-intercom              # 恢复推荐
```

配置写入 `~/.pi/agent/extensions/subagent/config.json`：

```json
{
  "companionSuggestions": {
    "packages": {
      "pi-intercom": {
        "dismissed": {
          "workspaces": ["/path/to/git/root"],
          "user": true
        }
      }
    }
  }
}
```

`isDismissed()` 通过 `companionWorkspaceKey(cwd)`（取最近的 git root）匹配 `workspaces` 数组。

## 消息发送

使用 `pi.sendMessage()` 而非 `pi.ui.notify()`：

```ts
pi.sendMessage({
  customType: "subagent_companion_suggestions",   // 自定义类型
  content: message,                                // 纯文本内容
  display: true,                                   // TUI 渲染
  details: { packages: [...] },                    // 元数据
});
```

- `customType` 是 `"subagent_companion_suggestions"`，pi 框架以默认 notification 形式渲染（未注册自定义 renderer）
- 消息构建函数 `buildCompanionStartupMessage()` 支持 1 个或 2 个包的不同措辞

## 其他表面

除 `session_start` 外，companion 推荐还在两个表面展示：

| 表面 | 触发方式 | 详情 |
|------|---------|------|
| `session_start` | 每次 TUI session 启动 | 本文描述的主要场景 |
| `list` | `subagent({ action: "list" })` | 调用 `buildCompanionListLines()`，简短的行列表 |
| `doctor` | `subagent({ action: "doctor" })` | 调用 `buildCompanionDoctorLines()`，包含每个包的详细诊断信息 |

## 相关文件

| 文件 | 作用 |
|------|------|
| `src/extension/companion-suggestions.ts` | 核心逻辑：状态收集、条件判断、消息构建、隐藏管理 |
| `src/extension/index.ts` | 注册 `session_start` 回调、slash 命令、消息渲染器 |
| `src/extension/config.ts` | 配置读写（config.json） |
| `src/intercom/intercom-bridge.ts` | intercom bridge 诊断和内容注入 |
| `src/shared/types.ts` | 类型定义（`CompanionSuggestionPackage`、`ExtensionConfig` 等） |

## 设计要点总结

1. **每 session 一次**：通过 state 标记防重复推送
2. **配置驱动**：支持用户级/workspace 级隐藏，全量禁用
3. **多表面复用**：同一套状态收集逻辑供 startup/list/doctor 三种表面使用
4. **自我检测**：通过检查 runtime 中是否有对应 tool/command 来判断包是否激活，避免重复推荐已安装的包
5. **无外部依赖**：纯扩展内实现，不需要独立的 notification 服务