/**
 * Ticket 38 acceptance tests — 组合根 bootstrap 正典顺序 + flock/pidfile 仲裁 + 优雅停机 + epoch 共用 + C1 降级。
 * C 层进程级双启动/SIGTERM 用真子进程（bin 入口）；启动顺序/epoch/降级用进程内 bootstrap（MemoryStore 注入 + 临时目录）。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonMain, fx, store, transport } from "../index.ts";

const { FileLock, FakeExec, FakeFs, FakePusher, SystemClock } = fx;

/** 每个 case 独立临时目录（unix path 长度受限，tmpdir 足够短）。 */
function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-events-t38-"));
}

/** 合法 profile 资产（profiles-registry.test 同构最小形）。 */
const PROFILE = {
  id: "fixture-widget",
  entityType: "fixture:widget",
  version: 1,
  states: ["green", "red"],
  transitions: [
    { from: "green", to: "red" },
    { from: "red", to: "green" },
  ],
  payloadSchema: { type: "object" },
  keyGenerator: { kind: "path", param: "path" },
  schedule: { type: "interval", every: "60s" },
  onTransition: [],
  templates: [
    { name: "watch", check: "cat {path}", params: { path: "被监视文件路径" }, usage: "监视文件判定器" },
  ],
  stateMigrations: {},
};

interface TestDaemon {
  daemon: daemonMain.DaemonHandle;
  dir: string;
  sockPath: string;
  pidPath: string;
  dbPath: string;
}

/** 进程内 bootstrap（MemoryStore + Fake exec/fs/pusher；时钟真值——自检/L3 面不依赖步进确定性）。 */
async function bootInProcess(overrides: Partial<daemonMain.BootstrapOptions> = {}): Promise<TestDaemon> {
  const dir = makeDir();
  const paths = { dir, sockPath: join(dir, "d.sock"), pidPath: join(dir, "d.pid") };
  const daemon = await daemonMain.bootstrap({
    ...paths,
    store: store.createMemoryStore(),
    clock: new SystemClock(),
    exec: new FakeExec(),
    pusher: new FakePusher(),
    fs: new FakeFs(),
    ...overrides,
  });
  return { daemon, dbPath: join(dir, "store.db"), ...paths };
}

const spawned: import("node:child_process").ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const child of spawned.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 真子进程启动（bin 入口）；ready = pidfile 出现 + socket 可连。 */
async function bootChild(dir: string, extra: Record<string, string> = {}): Promise<{
  child: import("node:child_process").ChildProcess;
  sockPath: string;
  pidPath: string;
}> {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const binPath = fileURLToPath(new URL("../bin/pi-events-daemon.ts", import.meta.url));
  const sockPath = join(dir, "d.sock");
  const pidPath = join(dir, "d.pid");
  const child = spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      "--no-warnings",
      binPath,
      "--sock",
      sockPath,
      "--db",
      join(dir, "store.db"),
      "--pid",
      pidPath,
      ...Object.entries(extra).flatMap(([k, v]) => [`--${k}`, v]),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  spawned.push(child);
  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`daemon child exited early (code=${child.exitCode} signal=${child.signalCode})`);
    }
    if (existsSync(pidPath) && existsSync(sockPath)) {
      try {
        const c = await transport.connectEvents(sockPath, { epoch: 0 }); // epoch 0 必被静默拒：能连上即 ready
        c.close();
        return { child, sockPath, pidPath };
      } catch {
        /* 未监听：继续等 */
      }
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting daemon ready (pidfile=${existsSync(pidPath)})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("票 38 组 1：bootstrap 正典顺序逐项断言", () => {
  it("十步顺序 lock→pidfile→epoch→store→profiles→selfcheck→queue→ledger→loops→serve；自检 ok（未注册会话 ENOENT=新会话常态）", async () => {
    const seen: daemonMain.BootstrapStep[] = [];
    const { daemon, pidPath } = await bootInProcess({
      profileAssets: [PROFILE],
      profileSchema: {},
      onStep: (s) => seen.push(s),
    });
    try {
      expect(daemon.steps).toEqual([
        "lock",
        "pidfile",
        "epoch",
        "store",
        "profiles",
        "selfcheck",
        "queue",
        "ledger",
        "loops",
        "serve",
      ]);
      expect(seen).toEqual(daemon.steps);
      expect(daemon.selfCheck.ok).toBe(true);
      expect(existsSync(pidPath)).toBe(true); // pidfile 已写入
      expect(daemon.epoch).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  });

  it("profile 装载产物注入 kernel：states 并集执法（profile 外状态拒、内状态落）", async () => {
    const { daemon } = await bootInProcess({ profileAssets: [PROFILE], profileSchema: {} });
    try {
      const ref = { type: "fixture:widget", key: "external/1" };
      daemon.store.putEntity({ type: ref.type, key: ref.key, state: "green" });
      daemon.loops.submit({ kind: "transition", ref, verdict: "failed", occurredAt: "2026-10-16T00:00:01Z" }); // ∉ profile states（green/red）→ 拒
      daemon.loops.submit({ kind: "transition", ref, verdict: "red" as "failed", occurredAt: "2026-10-16T00:00:02Z" }); // ∈ profile states → 落
      expect(daemon.loops.errors.length).toBe(1);
      expect(daemon.store.getEntity(ref.type, ref.key)?.state).toBe("red");
    } finally {
      await daemon.stop();
    }
  });
});

describe("票 38 组 2：flock 冲突 → 双启动拒绝报状态", () => {
  it("同 pidfile 二次 bootstrap → 报 already running（pid + pidfile 路径）；原 daemon 不受影响", async () => {
    const { daemon, pidPath, sockPath } = await bootInProcess();
    try {
      const err = await daemonMain
        .bootstrap({
          sockPath: join(makeDir(), "other.sock"),
          pidPath,
          store: store.createMemoryStore(),
          exec: new FakeExec(),
          pusher: new FakePusher(),
          fs: new FakeFs(),
        })
        .then(
          () => null,
          (e: unknown) => e as Error,
        );
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/already running \(pid \d+, pidfile .+\)/);
      // 原 daemon 存活可服务：错误 epoch 帧被静默拒 + 计数（I12 门活着）
      expect(daemon.transport.epochMismatches()).toBe(0);
      const c = await transport.connectEvents(sockPath, { epoch: daemon.epoch });
      await c.close();
    } finally {
      await daemon.stop();
    }
  });

  it("kill -9 残留 pidfile（死 pid）→ 新 daemon 回收重取可启动（自愈前置）", async () => {
    const dir = makeDir();
    dirs.push(dir);
    const pidPath = join(dir, "d.pid");
    writeFileSync(pidPath, "2147483646\n"); // 必不存在的 pid（ESRCH = 死持有者）
    const daemon = await daemonMain.bootstrap({
      sockPath: join(dir, "d.sock"),
      pidPath,
      store: store.createMemoryStore(),
      exec: new FakeExec(),
      pusher: new FakePusher(),
      fs: new FakeFs(),
    });
    await daemon.stop();
  });
});

describe("票 38 组 3：SIGTERM 优雅退出（真子进程）+ stop 语义", () => {
  it("SIGTERM → 退出码 0 + pidfile 清除 + socket 关闭（drain 后干净退场）", async () => {
    const dir = makeDir();
    dirs.push(dir);
    const { child, pidPath, sockPath } = await bootChild(dir);
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    expect(existsSync(pidPath)).toBe(true);
    child.kill("SIGTERM");
    const result = await exited;
    expect(result).toEqual({ code: 0, signal: null });
    expect(existsSync(pidPath)).toBe(false); // 锁已释放（重启可立即获锁）
    expect(existsSync(sockPath)).toBe(false); // socket 已清理
  });

  it("handle.stop() 幂等 + pidfile 清除（进程内路径）", async () => {
    const { daemon, pidPath } = await bootInProcess();
    await daemon.stop();
    await daemon.stop(); // 幂等
    expect(existsSync(pidPath)).toBe(false);
  });
});

describe("票 38 组 4：epoch 生成 + transport/run_ledger 共用", () => {
  it("transport 帧门与 run_ledger 行共用同一 epoch（getEpoch 单源；L0 subscribe 落 ownerEpoch）", async () => {
    const { daemon, sockPath } = await bootInProcess();
    try {
      // transport 端：错误 epoch → 静默拒 + 计数（无响应帧，不能 await —— 发后即查计数）；正确 epoch → 帧过门到 dispatch
      const wrong = await transport.connectEvents(sockPath, { epoch: daemon.epoch + 999 });
      void wrong.request("query", {}).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
      await wrong.close();
      expect(daemon.transport.epochMismatches()).toBe(1);

      const right = await transport.connectEvents(sockPath, { epoch: daemon.epoch });
      // 票 40：9 op dispatch 已接线——query 读侧 kernel 直调真实应答（帧过 epoch 门后进 op 面）
      await expect(right.request("query", {})).resolves.toEqual({ entities: [], deadLetters: [] });
      await right.close();

      // run_ledger 端：L0 subscribe → RunLedger.epoch === daemon.epoch（共用断言）
      daemon.store.putEntity({ type: "fixture:widget", key: "external/1", state: "waiting" });
      daemon.loops.submit({
        kind: "subscribe",
        req: { sessionId: "t1", entityRef: { type: "fixture:widget", key: "external/1" }, template: "watch", check: "true", now: Date.now() },
      });
      expect(daemon.store.getRunLedger("slot:fixture:widget:external/1#watch")?.epoch).toBe(daemon.epoch);
    } finally {
      await daemon.stop();
    }
  });
});

describe("票 38 评审修复 — Group Stop：stop() 时序（1H2M）", () => {
  it("并发 stop() 共享同一 shutdown promise（closed ??= doStop，票 29 client 同款）", async () => {
    const { daemon, pidPath } = await bootInProcess();
    const first = daemon.stop();
    expect(daemon.stop()).toBe(first); // 同一 promise：并发调用等待同一清算，不提前返回
    await first;
    expect(existsSync(pidPath)).toBe(false);
  });

  it("单阶段清理异常不跳过后续资源：独立 try/catch 收集，锁仍释放，AggregateError 统一抛", async () => {
    let released = 0;
    const lock = { acquire(): void {}, release(): void { released++; } };
    const badStore = Object.assign(store.createMemoryStore(), {
      close(): void {
        throw new Error("store close boom");
      },
    });
    const { daemon } = await bootInProcess({ store: badStore, lock });
    const err = await daemon.stop().then(
      () => null,
      (e: unknown) => e as AggregateError,
    );
    expect(err).toBeInstanceOf(AggregateError);
    expect(err!.errors).toHaveLength(1);
    expect(String(err!.errors[0])).toMatch(/store close boom/);
    expect(released).toBe(1); // store 异常未跳过锁释放
  });

  it("onStep 抛错不泄锁：step 回调在锁保护区（try）内，catch 逆序回收后 pidfile 不泄漏", async () => {
    const dir = makeDir();
    dirs.push(dir);
    const pidPath = join(dir, "d.pid");
    await expect(
      daemonMain.bootstrap({
        sockPath: join(dir, "d.sock"),
        pidPath,
        store: store.createMemoryStore(),
        exec: new FakeExec(),
        pusher: new FakePusher(),
        fs: new FakeFs(),
        onStep: (s) => {
          if (s === "pidfile") throw new Error("observer boom");
        },
      }),
    ).rejects.toThrow("observer boom");
    expect(existsSync(pidPath)).toBe(false); // 锁已回收：可重新获锁
  });

  it("bootstrap 失败先 await transport.close()（unlink 在 reject 前完成）：替换 daemon bind 不撞旧 socket 残留", async () => {
    const dir = makeDir();
    dirs.push(dir);
    const sockPath = join(dir, "d.sock");
    await expect(
      daemonMain.bootstrap({
        sockPath,
        pidPath: join(dir, "d.pid"),
        store: store.createMemoryStore(),
        exec: new FakeExec(),
        pusher: new FakePusher(),
        fs: new FakeFs(),
        onStep: (s) => {
          if (s === "serve") throw new Error("halt after serve");
        },
      }),
    ).rejects.toThrow("halt after serve");
    expect(existsSync(sockPath)).toBe(false); // socket 已 unlink：紧接的重新 bind 不会 EADDRINUSE
  });
});

describe("票 38 评审修复 — Group Lock：FileLock O_EXCL 竞态语义（3H1M）", () => {
  it("三进程交错（mock 时序）：pidfile 已建未写 pid 的窗口 → 拒取且不回收锁文件；活 pid 拒绝、死 pid 回收重取", () => {
    const dir = makeDir();
    dirs.push(dir);
    const pidPath = join(dir, "d.pid");
    writeFileSync(pidPath, ""); // 进程 A：open(wx) 已成功、writeSync(pid) 未落——交错窗口形态
    const b = new FileLock(pidPath, 2147483645);
    expect(() => b.acquire()).toThrow(/contended|unparseable/); // 空内容无法验证持有者死亡：fail-safe 拒取
    expect(readFileSync(pidPath, "utf8")).toBe(""); // B 未回收（A 随后写 pid 不受影响）

    writeFileSync(pidPath, `${process.pid}\n`); // A 落笔活 pid（测试进程必活）
    expect(() => b.acquire()).toThrow(/already running \(pid \d+/); // 活持有者：双启动拒绝

    writeFileSync(pidPath, "2147483646\n"); // A kill -9：死 pid 残留
    b.acquire(); // 回收重取成功（死 pid 自愈路径不回归）；此刻锁内容 = B 自己的 pid
    expect(readFileSync(pidPath, "utf8")).toBe("2147483645\n");
    b.release();
  });

  it("pidfile 不可读（EACCES I/O 错）≠ stale：原样上抛，不接管不回收", () => {
    const dir = makeDir();
    dirs.push(dir);
    const pidPath = join(dir, "d.pid");
    writeFileSync(pidPath, "2147483646\n");
    chmodSync(pidPath, 0o000); // 非 root：读必 EACCES
    let caught: unknown = null;
    try {
      new FileLock(pidPath, 2147483645).acquire();
    } catch (err) {
      caught = err;
    }
    expect((caught as NodeJS.ErrnoException)?.code).toBe("EACCES"); // 读错误 ≠ stale：不碰锁，原样上抛
    expect(existsSync(pidPath)).toBe(true); // 锁未被回收
    chmodSync(pidPath, 0o644); // afterEach rmSync 可清
  });

  it("release 校验锁内 pid 是自己才删：他人锁不误删、自身锁删除、已释放幂等", () => {
    const dir = makeDir();
    dirs.push(dir);
    const pidPath = join(dir, "d.pid");
    writeFileSync(pidPath, "111\n");
    new FileLock(pidPath, 222).release(); // 内容非自己 pid：不删（锁已被他人接管形态）
    expect(readFileSync(pidPath, "utf8")).toBe("111\n");
    new FileLock(pidPath, 111).release(); // 自己的锁：删
    expect(existsSync(pidPath)).toBe(false);
    expect(() => new FileLock(pidPath, 111).release()).not.toThrow(); // 已释放：幂等
  });
});

describe("票 38 组 5：自检失败 → 降级运行（C1 联动）", () => {
  it("sessionFile 不可读（目录=EISDIR 非 ENOENT）→ selfCheck 失败降级，daemon 仍 serving", async () => {
    const seen: daemonMain.BootstrapStep[] = [];
    const { daemon } = await bootInProcess({
      sessionRefs: [{ sessionId: "s1", sessionFile: makeDir() }], // 目录：readFile → EISDIR → unreadable
      fs: new fx.NodeFs(), // 真文件面：FakeFs 会把目录读遮蔽成 ENOENT（新会话常态）——EISDIR 路径需真 fs
      onStep: (s) => seen.push(s),
    });
    try {
      expect(daemon.selfCheck.ok).toBe(false);
      expect(daemon.selfCheck.reason).toMatch(/unreadable/i);
      expect(daemon.steps).toEqual([
        "lock",
        "pidfile",
        "epoch",
        "store",
        "profiles",
        "selfcheck",
        "queue",
        "ledger",
        "loops",
        "serve",
      ]); // 降级不阻断启动：serve 照常到达
      expect(daemon.transport.epochMismatches()).toBe(0);
    } finally {
      await daemon.stop();
    }
  });
});
