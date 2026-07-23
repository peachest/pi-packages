# oh-my-pet

> English · [中文文档](./README.zh.md)

> 一只生活在你的代码库中的数字宠物，从你的 AI agent 使用中成长。

每个项目一只宠物，跨所有贡献者和所有 AI agent 会话（pi、Claude Code 等）共享。不会打扰你，只是一个在状态栏中的小生命。

## 它是如何工作的

你的宠物从你的编码活动中成长：

- **`core.exp`** — 经验值，来自输出 token（消息量）
- **`core.vitality`** — 活力值，来自输出 token 速度（tokens/sec）
- **`core.fullness`** — 饱腹值，来自上下文使用百分比

每个宠物会话写入一个只追加的 binlog。同一项目上的多个 agent 会话可以无冲突地并发写入。启动时，框架回放 binlog 条目来计算当前宠物状态。

### 命令

| 命令 | 描述 |
|------|------|
| `/pet` | 显示宠物仪表盘——当前属性、等级和最近的喂养记录 |

## 状态栏

你的宠物始终可见于 pi 状态栏：

```
🐶 Lv.3 [████░░░░░░] 42% 🏃28
```

无需额外按键——瞥一眼即可。

## 概念

参见 [CONTEXT.md](./CONTEXT.md) 获取完整术语表（Pet、Mod、Binlog、Adaptor Layer、Attribute Policy 等）。

## 安装

```bash
pi install /path/to/oh-my-pet
```

## 开发

```bash
npm test           # vitest run
npm run test:watch # vitest watch
npm run lint       # eslint
```
