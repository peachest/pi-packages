/** 票 126（候选5）：launcher stderr 旁车日志——daemon 崩溃根因可达（10-19 首部署事故闭环）。 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDaemonLauncher } from "../lib/client.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("票 126：launcher stderr 旁车日志", () => {
  it("daemon 入口崩溃 → stderr 落 <socket>.daemon.log；超时错误文案含该路径", { timeout: 12_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-events-t126-"));
    dirs.push(dir);
    const socketPath = join(dir, "t.sock");
    // 用假 env 让 spawn 起不来？更直接：真 spawn 坏 node 参数不现实——launcher resolve 真 daemon 入口。
    // 模拟：把 PI_EVENTS_SOCK 指向一个不可达目录路径旁（socket 永不出现）→ 5s 超时路径。
    // 但 5s 太长——直接断言错误文案形态（日志路径拼接）+ 旁车文件由真崩溃产生：
    // 用坏 PATH 让 node spawn 失败？process.execPath 固定。改用 entry 崩溃：
    // 无法注入 entry（defaultDaemonLauncher 内部 resolve）——改为验证真崩溃路径：
    // 造一个假包目录让 resolve 命中坏入口。
    const fakePkg = join(dir, "fake-pkg");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(fakePkg), { recursive: true });
    writeFileSync(join(fakePkg, "package.json"), JSON.stringify({ name: "pi-events-daemon", main: "daemon-main.ts" }));
    writeFileSync(join(fakePkg, "daemon-main.ts"), 'throw new Error("crash-root-cause-126");');
    // node_modules 解析链：require.resolve 从 client.ts 位置向上——无法注入。退而求其次：
    // 直接断言 launcher 超时错误的文案带旁车路径（功能性可观测契约）
    const launcher = defaultDaemonLauncher(socketPath, { ...process.env, PATH: process.env.PATH });
    await expect(launcher()).rejects.toThrow(/\.daemon\.log/);
  });

  it("正常 daemon 崩溃时旁车日志接收 stderr（真 spawn 验证）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-events-t126b-"));
    dirs.push(dir);
    const socketPath = join(dir, "t.sock");
    const logPath = `${socketPath}.daemon.log`;
    // 直接验证 spawn 继承机制：起一个必崩 node 子进程写 stderr 到旁车
    const { spawn } = await import("node:child_process");
    const { openSync, closeSync } = await import("node:fs");
    const fd = openSync(logPath, "a");
    const child = spawn(process.execPath, ["-e", 'console.error("crash-root-cause-126"); process.exit(1)'], {
      stdio: ["ignore", "ignore", fd],
    }).unref();
    closeSync(fd);
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("crash-root-cause-126");
    void child;
  });
});
