#!/usr/bin/env python3
"""write-home-guard — Write/Edit 工具的目标路径守卫（kendex hook，票 R3）。

背景（挖掘报告 ~/tmp/retro-write-home-mining.md）：模型按 Linux 惯例把 home 写成
/home/<user>，本机真实 home 是 /mnt/disk1/hyx（HOME 与 passwd 双证），/home 下没有
hyx 用户——写 /home/hyx/* 必报 EACCES。2026-07→10 全库 9 次，全 write、0 edit。

规则：Write/Edit 的目标路径展开 ~（与 pi 一致用 $HOME）并 realpath -m 归一化后，
落在 /home/* 下即拦截（本机没有合法的 /home/hyx 写场景；/home/fuxin 等其他用户
写了自然会失败，但同样提示）。其余路径（/mnt/*、/tmp、相对路径）一律放行。

Verdict 约定同 bash-guards：exit 2 + stderr（三要素：原因/推荐/示例）拦截，
exit 0 放行；payload 不可解析 fail-open。
"""
import json
import os
import subprocess
import sys


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        return 0  # fail-open: 解析失败绝不拦
    path = (payload.get("tool_input") or {}).get("path")
    if not isinstance(path, str) or not path.strip():
        return 0

    # ~ 展开与 pi 的 normalizePath 同源（$HOME，本机 = /mnt/disk1/hyx）
    expanded = os.path.expanduser(path)
    if not expanded.startswith("/home/"):
        # 相对路径也要 realpath 归一化（cwd 相对写不到 /home，直接放行）
        return 0

    # realpath -m：目标可以不存在（write 会 mkdir parents），-m 不要求存在
    try:
        real = subprocess.run(
            ["realpath", "-m", expanded], capture_output=True, text=True, timeout=5
        ).stdout.strip()
    except Exception:
        real = os.path.normpath(expanded)  # realpath 失败：退化到 normpath，仍可判前缀

    if not real.startswith("/home/"):
        return 0

    user = real.split("/")[2] if real.count("/") >= 2 else ""
    home = os.environ.get("HOME", "")
    block(
        f"write-home-guard: 目标路径 {real} 落在 /home/{user} 下——本机真实 home 是 "
        f"{home}（HOME 与 passwd 双证），/home/{user or 'hyx'} 不存在，写入必报 "
        f"EACCES。这是模型的 Linux 惯例误推（2026-07→10 全库 9 次实证，全 write）。"
        f"推荐：改用 {home}/... 或 ~ 开头重写路径——例如 ~{real[len('/home/hyx'):] if real.startswith('/home/hyx') else '/tmp/x.md'}。"
        f"若确需写其他用户目录（如 /home/fuxin），确认权限后用绝对路径并自行承担失败。"
    )
    return 2


def block(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    sys.exit(main())
# auto-sync probe 1793031540
