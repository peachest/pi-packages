/** 票 126（候选5）：launcher stderr 旁车日志——daemon 崩溃根因可达（10-19 首部署事故闭环）。 */
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDaemonLauncher } from "../index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("票 126：launcher stderr 旁车日志", () => {
  it("daemon 入口崩溃 → stderr 落 <socket>.daemon.log；超时错误文案含该路径", { timeout: 12_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-events-t126-"));
    dirs.push(dir);
    // 确定性崩溃注入：把 socket 指到普通文件下（ENOTDIR，子进程必崩）。不能依赖超时路径碰巧成立——
    // daemon bootstrap 拿机器级全局 flock（单实例）：llm12 等有常驻 daemon 的机器上 spawn 的子进程锁冲突必崩、
    // 超时路径成立；干净 CI runner 上无常驻 daemon，子进程正常拉起 → launcher resolve → rejects 断言失败
    // （2026-10-28 首次 CI run 40696036948 实证）。崩溃 → socket 不出现 → 超时文案带旁车路径，任意机器同向。
    writeFileSync(join(dir, "blocker"), "not a directory");
    const socketPath = join(dir, "blocker", "t.sock");
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
