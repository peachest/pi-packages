/**
 * Ticket 39 acceptance tests — kill -9 崩溃自愈三件套（C 层真进程）：全槽归零重探（A5）+ missed cron
 * catch_up_one 恰一次 + GC（L4 首轮）+ X4/X5 进程级时序场景。store 是唯一真相源：重启 = 纯重放，
 * 全部断言经 SqliteStore 观测面（第二连接读，WAL 多进程）；事件恰一次由 appendIfMissing 幂等收口。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { store, transport } from "../index.ts";
import type { ChildProcess } from "node:child_process";

type SqliteStore = InstanceType<typeof store.SqliteStore>;

const REF = { type: "fixture:widget", key: "external/1" };
const SLOT = "slot:fixture:widget:external/1#watch";
const TEMPLATE = "watch";
const SESSION = "t1";
/** 确定性事件 id 正典格式（crash-inject.test 同法字面量钉死）：evt:<type>:<key>#<decisionOrder>。 */
const EVENT_ID_1 = "evt:fixture:widget:external/1#1";

const spawned: ChildProcess[] = [];
const dirs: string[] = [];
const openStores: { close(): void }[] = [];
afterEach(() => {
  for (const child of spawned.splice(0)) child.kill("SIGKILL");
  for (const s of openStores.splice(0)) {
    try {
      s.close();
    } catch {
      /* 已关即目标 */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const waitFor = async (cond: () => boolean, what: string, ms = 6000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const firingsCount = (firingsPath: string): number => {
  try {
    return readNonEmptyLines(firingsPath).length;
  } catch {
    return 0;
  }
};
const readNonEmptyLines = (path: string): string[] =>
  existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "")
    : [];

interface Seed {
  dir: string;
  dbPath: string;
  sockPath: string;
  pidPath: string;
  firings: string;
  db: SqliteStore;
}

/** SqliteStore 种子（测试进程直写真相源；重启 = daemon 纯重放这些行）。 */
function seed(dir: string, opts: { check: string; schedule: { type: "interval"; intervalMs: number } | { type: "cron"; cron: string }; nextDueAt?: number }): Seed {
  const dbPath = join(dir, "store.db");
  const db = new store.SqliteStore(dbPath);
  openStores.push(db);
  db.putEntity({ type: REF.type, key: REF.key, state: "waiting" });
  db.putProbeSpec({ slotKey: SLOT, check: opts.check, schedule: opts.schedule, source: "poll" });
  db.putRunLedger({
    slotKey: SLOT,
    epoch: 0,
    refcount: 1,
    consecutiveFails: 0,
    lastVerdict: "waiting",
    nextDueAt: opts.nextDueAt,
    entityRefType: REF.type,
    entityRefKey: REF.key,
    generation: 0,
  });
  db.putSubscription({
    subscriptionId: "sub-0001",
    sessionId: SESSION,
    entityRefType: REF.type,
    entityRefKey: REF.key,
    template: TEMPLATE,
    check: opts.check,
    origin: "session",
    scope: "project",
    createdAt: Date.now(),
  });
  return { dir, dbPath, sockPath: join(dir, "d.sock"), pidPath: join(dir, "d.pid"), firings: join(dir, "firings"), db };
}

/** 真子进程 daemon（bin 入口）；ready = pidfile + socket 可连。 */
async function bootChild(seedInfo: Seed, sessions?: string): Promise<ChildProcess> {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const binPath = fileURLToPath(new URL("../bin/pi-events-daemon.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      "--no-warnings",
      binPath,
      "--sock",
      seedInfo.sockPath,
      "--db",
      seedInfo.dbPath,
      "--pid",
      seedInfo.pidPath,
      ...(sessions ? ["--sessions", sessions] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[daemon] ${d}`));
  spawned.push(child);
  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`daemon child exited early (code=${child.exitCode} signal=${child.signalCode})`);
    }
    if (existsSync(seedInfo.pidPath) && existsSync(seedInfo.sockPath)) {
      try {
        const c = await transport.connectEvents(seedInfo.sockPath, { epoch: 0 });
        c.close();
        return child;
      } catch {
        /* 未监听：继续等 */
      }
    }
    if (Date.now() > deadline) throw new Error("timeout waiting daemon ready");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const exitOf = (child: ChildProcess): Promise<{ code: number | null; signal: string | null }> =>
  new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

describe("票 39 组 1：kill -9 → 重启 → run_ledger 全部槽归零重探（A5）+ 无重复事件 + GC L4 首轮", () => {
  it("重探刷新 verdict（firings 递增）、事件不重（appendIfMissing 幂等收口）、过期 evidence 首扫清除", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-events-t39-"));
    dirs.push(dir);
    const s = seed(dir, { check: `echo x >> ${join(dir, "firings")}`, schedule: { type: "interval", intervalMs: 60_000 } });
    s.db.putEvidence({ evidenceRef: "ev-old", content: "stale", recordedAt: Date.now() - 31 * 86_400_000 }); // 30d 长桶外 → L4 首扫删
    s.db.putEvidence({ evidenceRef: "ev-new", content: "fresh", recordedAt: Date.now() });

    // boot1：首探 → waiting→passed 事件 #1 → fanOut（无活跃 session → parked）
    const c1 = await bootChild(s);
    await waitFor(() => firingsCount(s.firings) >= 1, "boot1 probe");
    await waitFor(() => s.db.outboxBatch(10).length === 1, "event #1");
    expect(s.db.outboxBatch(10).map((r) => r.notificationId)).toEqual([EVENT_ID_1]);
    expect(s.db.getDelivery(EVENT_ID_1, SESSION)?.state).toBe("parked");

    // kill -9（崩溃矩阵 X4/X5 载体）：无优雅路径，残留 pidfile/socket 由重启侧回收
    const death = exitOf(c1);
    c1.kill("SIGKILL");
    expect(await death).toEqual({ code: null, signal: "SIGKILL" });

    // boot2：全部槽归零重探——firings 递增 = 探针重放（拿最新事实）；verdict 不翻 → 事件不重
    const c2 = await bootChild(s);
    await waitFor(() => firingsCount(s.firings) >= 2, "boot2 re-probe");
    await new Promise((r) => setTimeout(r, 500)); // 重探余波窗口：无第二事件/无重复投递行
    expect(firingsCount(s.firings)).toBe(2); // 恰一次重探（在飞守卫 + nextDueAt 重排，无循环补探）
    expect(s.db.outboxBatch(10).map((r) => r.notificationId)).toEqual([EVENT_ID_1]); // appendIfMissing 幂等收口
    expect(s.db.getDelivery(EVENT_ID_1, SESSION)?.state).toBe("parked"); // I10 恰一行
    const ledger = s.db.getRunLedger(SLOT);
    expect(ledger?.lastVerdict).toBe("passed"); // verdict 刷新（A5 最新事实）
    expect(ledger?.nextDueAt).toBeGreaterThan(Date.now()); // 调度重臂
    // GC L4 首轮（启动惰性首扫 delay 0）：过期证据删、新鲜证据留
    expect(s.db.evidenceOlderThan(Number.MAX_SAFE_INTEGER).map((r) => r.evidenceRef)).toEqual(["ev-new"]);
    const shutdown = exitOf(c2);
    c2.kill("SIGTERM");
    await shutdown;
  });
});

describe("票 39 组 2：missed cron catch_up_one 恰一次（不多不少）", () => {
  it("停机跨过 2 个 cron 到点 → 重启合并补触发一次，nextDueAt 跳到下一未来到点", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-events-t39-"));
    dirs.push(dir);
    const s = seed(dir, {
      check: `echo x >> ${join(dir, "firings")}`,
      schedule: { type: "cron", cron: "* * * * *" },
      nextDueAt: Date.now() - 120_000, // 停机期间 missed 2 tick
    });

    const child = await bootChild(s);
    await waitFor(() => firingsCount(s.firings) >= 1, "catch_up probe");
    await new Promise((r) => setTimeout(r, 1200)); // 无逐点补齐：missed N 合并为一次
    expect(firingsCount(s.firings)).toBe(1);
    const ledger = s.db.getRunLedger(SLOT);
    expect(ledger?.nextDueAt).toBeGreaterThan(Date.now()); // 直接跳下一未来到点
    expect(ledger?.lastVerdict).toBe("passed");
    const shutdown = exitOf(child);
    child.kill("SIGTERM");
    await shutdown;
  });
});

describe("票 39 组 3：X4/X5 进程级时序场景（SESSION_START drain 竞态 + accepted 未 verified 重启收口）", () => {
  it("X5：SESSION_START→drain→parked 兑现推送到达；X4：kill -9 后 accepted 行经 L3 点查收口 verified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-events-t39-"));
    dirs.push(dir);
    const s = seed(dir, { check: "true", schedule: { type: "interval", intervalMs: 60_000 } });
    const sessionFile = join(dir, "t1.jsonl");

    // boot1：首探 → 事件 #1 → parked（client 未连）
    const c1 = await bootChild(s);
    await waitFor(() => s.db.outboxBatch(10).length === 1, "event #1");

    // X5：SESSION_START 长连接 → L0 drain（parked→accepted）→ wake snapshot 推送到达同一连接
    const client = await transport.connectEvents(s.sockPath, { epoch: 0 });
    const pushes: Array<{ method: string; params: unknown }> = [];
    client.onNotification((method, params) => pushes.push({ method, params }));
    client.startSession(SESSION);
    await waitFor(() => pushes.length > 0, "wake push");
    expect(pushes[0]).toMatchObject({
      method: "wake",
      params: { sessionId: SESSION, count: 1, entries: [{ notificationId: EVENT_ID_1, entityRef: "fixture:widget:external/1", verdict: "passed" }] },
    });
    await waitFor(() => s.db.getDelivery(EVENT_ID_1, SESSION)?.state === "accepted", "drain accepted");
    client.close();

    // kill -9：accepted 行未 verified（X4 崩溃点）
    const death1 = exitOf(c1);
    c1.kill("SIGKILL");
    await death1;
    expect(s.db.getDelivery(EVENT_ID_1, SESSION)?.state).toBe("accepted");

    // extension 忠实转写（进程外 leg）：通知条目落 transcript → 重启 L3 点查收口
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3 })}\n`);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "custom_message",
        customType: "pi-events.notification",
        content: `billboard: ${EVENT_ID_1}`,
        details: { notificationId: EVENT_ID_1, verdict: "passed" },
        id: "e2",
        parentId: "e1",
        timestamp: "2026-10-16T00:00:01.000Z",
      })}\n`,
    );

    const c2 = await bootChild(s, JSON.stringify([{ sessionId: SESSION, sessionFile }]));
    await waitFor(() => s.db.getDelivery(EVENT_ID_1, SESSION)?.state === "verified", "L3 verified after restart");
    const shutdown = exitOf(c2);
    c2.kill("SIGTERM");
    await shutdown;
  });
});
