import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { fx } from "../index.ts";

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("fx 真壳存在性证明（票 12 断言 1）", () => {
  it("SystemClock: 真时钟单增，真 setTimeout 到点触发、cancel 生效", async () => {
    const clock: fx.Clock = new fx.SystemClock();
    const t0 = clock.now();
    expect(clock.now()).toBeGreaterThanOrEqual(t0);

    const firedAt: number[] = [];
    await new Promise<void>((resolve) =>
      clock.setTimeout(() => {
        firedAt.push(clock.now());
        resolve();
      }, 8),
    );
    expect(firedAt[0]).toBeGreaterThan(t0);

    const handle = clock.setTimeout(() => firedAt.push(-1), 8);
    handle.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(firedAt).toHaveLength(1);
  });

  it("ShellExec: 真 spawn 返回平台原形（exitCode/stdout/stderr）", async () => {
    const exec: fx.Exec = new fx.ShellExec();
    const ok = await exec.run("echo fx-real");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toBe("fx-real\n");
    expect(ok.stderr).toBe("");
    expect(ok.timedOut).toBe(false);

    const failed = await exec.run("echo boom >&2; exit 3");
    expect(failed.exitCode).toBe(3);
    expect(failed.stderr).toBe("boom\n");
  });

  it("ShellExec: timeoutMs 到点杀进程并标记 timedOut", async () => {
    const exec: fx.Exec = new fx.ShellExec();
    const res = await exec.run("sleep 2", { timeoutMs: 50 });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
  });

  it(
    "ShellExec: 忽略 SIGTERM 的 hung checker（trap）→ 宽限期后 SIGKILL 升级整进程组，run 必结算（Exec 契约：timeoutMs 后承诺必落地）",
    async () => {
      const exec: fx.Exec = new fx.ShellExec();
      const res = await exec.run("trap '' TERM; while :; do sleep 1; done", { timeoutMs: 100 });
      expect(res.timedOut).toBe(true);
      expect(res.exitCode).toBeNull();
      expect(res.signal).toBe("SIGKILL");
    },
    20_000,
  );

  it("NodeFs: 真文件读（utf-8 全文；缺失文件 ENOENT 原形上抛）", async () => {
    const dir = tmpDir("eda-fx-fs-");
    const file = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(file, '{"v":3}\n{"v":4}\n');
    const f: fx.Fs = new fx.NodeFs();
    await expect(f.readFile(file)).resolves.toBe('{"v":3}\n{"v":4}\n');
    await expect(f.readFile(path.join(dir, "missing.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("SocketPusher: 真 unix socket 推送，客户端逐行收到；同路径重启可用", async () => {
    const sockPath = path.join(tmpDir("eda-fx-sock-"), "wake.sock");
    const line = '{"jsonrpc":"2.0","method":"wake/test"}';

    const realPusher = new fx.SocketPusher(sockPath);
    const pusher: fx.Pusher = realPusher; // 真壳满足端口（注入面可用）
    const received: string[] = [];
    const client = net.connect(sockPath);
    client.on("data", (chunk: Buffer) => received.push(chunk.toString()));
    await once(client, "connect");
    // vi.waitFor 轮询容忍 connect 与服务端 connection 事件的无保证顺序（真 daemon 先连后推，无此竞态）
    await vi.waitFor(async () => {
      await pusher.push(line);
      expect(received.join("")).toBe(line + "\n");
    });
    await realPusher.close();
    client.destroy();

    // 重启同路径：constructor 先 unlink 遗留 socket 文件再 listen（daemon kill 自愈前置）
    const realPusher2 = new fx.SocketPusher(sockPath);
    const received2: string[] = [];
    const client2 = net.connect(sockPath);
    client2.on("data", (chunk: Buffer) => received2.push(chunk.toString()));
    await once(client2, "connect");
    await vi.waitFor(async () => {
      await realPusher2.push(line);
      expect(received2.join("")).toBe(line + "\n");
    });
    await realPusher2.close();
    client2.destroy();
  });
});

describe("fx 端口契约（票 12 断言 2：端口类型零业务泄漏 + Fs 只读收窄）", () => {
  it("公共面 = 真壳四件套（票 12）+ 四端口 fake（票 13，逐步到位）", () => {
    expect(Object.keys(fx).sort()).toEqual(
      ["FakeClock", "FakeExec", "FakeFs", "FakePusher", "NodeFs", "ShellExec", "SocketPusher", "SystemClock"],
    );
  });

  it("端口签名只用原始值（零业务泄漏）", () => {
    expectTypeOf<fx.Fs>().toEqualTypeOf<{ readFile(path: string): Promise<string> }>();
    expectTypeOf<fx.Pusher>().toEqualTypeOf<{ push(line: string): Promise<void> }>();
    expectTypeOf<fx.Clock["now"]>().toEqualTypeOf<() => number>();
    expectTypeOf<fx.Clock["setTimeout"]>().toEqualTypeOf<
      (fn: () => void, ms: number) => { cancel(): void }
    >();
    expectTypeOf<fx.Exec["run"]>().toEqualTypeOf<
      (command: string, opts?: fx.ExecOptions) => Promise<fx.ExecResult>
    >();
    expectTypeOf<fx.ExecResult["exitCode"]>().toEqualTypeOf<number | null>();
    expectTypeOf<fx.ExecResult["signal"]>().toEqualTypeOf<string | null>();
    expectTypeOf<fx.ExecResult["timedOut"]>().toEqualTypeOf<boolean>();
    expectTypeOf<fx.ExecOptions["timeoutMs"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<fx.ExecOptions["env"]>().toEqualTypeOf<Record<string, string> | undefined>();
  });

  it("Fs 无写方法（fx.md“文件读写”→只读的收窄裁定，类型化承诺）", () => {
    const f: fx.Fs = new fx.NodeFs();
    // @ts-expect-error 收窄裁定：Fs 接口无写方法（票 12）
    void f.writeFile;
    // @ts-expect-error
    void f.appendFile;
    // @ts-expect-error
    void f.mkdir;
  });
});
