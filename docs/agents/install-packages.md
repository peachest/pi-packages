# 安装与管理本地包

本仓库 `packages/` 下的包通过 `pi install` 安装到 pi，安装结果记录在 `settings.json` 的 `packages` 字段。

## 安装

```bash
# 安装单个包（从仓库根执行）
pi install ./packages/<name>

# 安装到项目本地（.pi/settings.json）而非全局
pi install -l ./packages/<name>
```

## 批量安装

`pi install` 一次只装一个。批量安装当前仓库所有包：

```bash
for pkg in packages/*/; do pi install "./$pkg"; done
```

纯工具包（无 `pi.extensions` 字段，如 `pi-i18n-utils`）不是扩展，`pi install` 会报 "does not export a valid factory function" 警告——不要把它加进 `settings.json` 的 extensions 数组。这类包只通过下面的 link 步骤让其它包能 import 即可。

## 本地 workspace 依赖链接

`pi-proxy` 和 `pi-wishlist` 的 `import ... from "pi-i18n-utils"` 依赖 Node 从 `node_modules/` 解析该包。`node_modules/` 被 git 忽略、不在版本控制里，所以必须手动 link 到**仓库根 `node_modules/`**（pi 的 jiti loader 从扩展文件所在目录**向上搜索** `node_modules/`，`~/.pi/agent/npm 不在搜索链上），否则 pi 启动加载扩展时报` Cannot find module 'pi-i18n-utils'`：

```bash
# 在仓库根建软链（从扩展文件向上搜索的必经节点）
mkdir -p node_modules
ln -sfn ../packages/pi-i18n-utils node_modules/pi-i18n-utils
```

# 验证解析链（模拟 pi 的 jiti loader）
node -e "console.log(require.resolve('pi-i18n-utils',{paths:['packages/pi-proxy/state/']}))"

换机器或清掉仓库 `node_modules/` 后需重新执行。

> 注意：`~/.pi/agent/npm` 里的软链在 pi 0.84.3 下**无效**——jiti 以 `import.meta.url`（loader.js 所在处）为 base，扩展依赖的裸模块从**扩展文件目录**向上搜索，永远走不到 `~/.pi/agent/npm`。

## 管理

```bash
# 移除
pi remove ./packages/<name>

# 查看已装：读 settings.json 的 packages 字段
```

## 为什么不能手动复制

`pi install` 会把包源写入 `settings.json`，pi 启动时据此加载。手动复制到 `~/.pi/agent/extensions/` 的文件不在 settings 里，升级时不会被刷新，卸载时不会被清理，和 `pi install` 装的版本会产生冲突。
