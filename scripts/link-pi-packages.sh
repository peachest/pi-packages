#!/usr/bin/env bash
# link-pi-packages — 把 settings.json 引用的本地路径包软链进 pi 的 npm 区。
#
# 为什么：pi install 本地路径不装依赖（官方："their dependency tree remains the
# package author's responsibility"），jiti 从扩展文件向上找 node_modules——repo 在
# worktree 里或根依赖不全时解析断（2026-10-26 ask-question 事故）。包软链进
# ~/.pi/agent/npm/node_modules/<name> 后，依赖从 pi npm 区平级解析，与 repo 检出
# 位置解耦；源码仍是软链目标，改完即时生效（零拷贝）。
#
# 用法：
#   scripts/link-pi-packages.sh            # 对 settings 引用的本地包建/修链接
#   scripts/link-pi-packages.sh --prune    # 同时清掉指向死路径的旧链接
#
# post-commit 自动调用：只 relink 本次 commit 改动的包（见 .git/hooks 接线）。
set -euo pipefail

SETTINGS="${HOME}/.pi/agent/settings.json"
NPM_DIR="${HOME}/.pi/agent/npm/node_modules"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRUNE=0
[ "${1:-}" = "--prune" ] && PRUNE=1

mkdir -p "$NPM_DIR"

# 本地路径包清单：settings.packages 里 packages/<name> 形态的条目 → 绝对路径
local_pkg_paths() {
    python3 - "$SETTINGS" "$REPO" <<'PY'
import json, os, sys
settings, repo = sys.argv[1], sys.argv[2]
d = json.load(open(settings))
for p in d.get("packages", []):
    src = p["source"] if isinstance(p, dict) else p
    if isinstance(src, str) and src.startswith("../../projects/pi-mypackage/packages/"):
        dirname = src.split("/packages/")[1]
        full = os.path.join(repo, "packages", dirname)
        if not os.path.isdir(full):
            print(f"DEAD\t{src}")
            continue
        # 链接名 = package.json 的 name（npm 正典，含 scope）；目录名可能不同
        try:
            name = json.load(open(os.path.join(full, "package.json")))["name"]
        except Exception:
            name = dirname
        print(f"{name}\t{full}")
PY
}

linked=0; dead=0
while IFS=$'\t' read -r name full; do
    if [ "$name" = "DEAD" ]; then
        echo "link-pi-packages: WARN settings 引用死路径: $full" >&2
        dead=$((dead+1)); continue
    fi
    # 包名可能带 scope（@org/name）；目录结构对应 @org/name
    target="$NPM_DIR/$name"
    if [ -L "$target" ] && [ "$(readlink "$target")" = "$full" ]; then
        continue  # 幂等：已指向正确位置
    fi
    if [ -e "$target" ] && [ ! -L "$target" ]; then
        echo "link-pi-packages: SKIP $name — 目标已存在且非软链，需人工处理" >&2
        continue
    fi
    mkdir -p "$(dirname "$target")"
    ln -sfn "$full" "$target"
    echo "link-pi-packages: linked $name → $full" >&2
    linked=$((linked+1))
done < <(local_pkg_paths)

# --prune：清掉 npm 区里指向不存在目标的软链（worktree 删除遗留）
if [ "$PRUNE" = 1 ]; then
    # 断链枚举不能用 find -type L（环境 find 不支持）；shell 判断可靠且量小
    for l in "$NPM_DIR"/* "$NPM_DIR"/*/*; do
        [ -L "$l" ] || continue
        [ -e "$l" ] || { echo "link-pi-packages: pruning dead link $l" >&2; rm -f "$l"; }
    done
fi

# 汇总行只在有动作时输出，避免每次 commit 噪音
[ "$linked" -gt 0 ] || [ "$dead" -gt 0 ] && echo "link-pi-packages: linked=$linked dead=$dead" >&2
exit 0
