/**
 * Ticket 40 acceptance tests — C 层端到端全链路验收（终票）。
 *
 * 真实 daemon 进程（bin 入口子进程）+ JSON-RPC socket 客户端（transport client fixture）+
 * transcript fixture 文件驱动。全部业务动作走 9 op dispatch（无 store 直写种子，除 evidence
 * 行——probe evidence 落盘链路未接，见票 40 报告遗留），断言经 SqliteStore 观测面（第二连接，
 * WAL 多进程）+ op 响应 + wake 推送三面收口。
 *
 * 覆盖面：
 *   - 两段式 ack 双路径：accepted→verified（在线推送→transcript 点查）、parked→drain→verified
 *   - 五条顺序约束端到端各一断言：update_hook 唤醒 / Intent 串行 / 缓存提交序 /
 *     阈值先建者定跨重启 / epoch 拒僵尸
 *   - extension→daemon 全链路（pi 会话由 client fixture 模拟）：subscribe→probe 翻转→wake 注入到达
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { store, transport } from "../index.ts";
import type { ChildProcess } from "node:child_process";

type EventsClient = Awaited<ReturnType<(typeof transport)["connectEvents"]>>;

type SqliteStore = InstanceType<typeof store.SqliteStore>;

const spawned: ChildProcess[] = [];
const dirs: string[] = [];
const openStores: { close(): void }[] = [];
const clients: EventsClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
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

const waitFor = async (cond: () => boolean, what: string, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

interface Runtime {
  dir: string;
  sockPath: string;
  dbPath: string;
  db: SqliteStore;
}

/** 干净数据目录（无种子——全部业务经 9 op 驱动）；db 连接仅作观测面。 */
function makeRuntime(): Runtime {
  const dir = mkdtempSync(join(tmpdir(), "pi-events-t40-"));
  dirs.push(dir);
  const dbPath = join(dir, "store.db");
  const db = new store.SqliteStore(dbPath);
  openStores.push(db);
  return { dir, sockPath: join(dir, "d.sock"), dbPath, db };
}

/** transcript fixture 会话文件（票 19-21 v3 JSONL 形态：session 头行 + custom_message 通知条目）。 */
function makeSessionFile(dir: string, sessionId: string): string {
  const f = join(dir, `${sessionId}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "session", version: 3 })}\n`);
  return f;
}

/** 真子进程 daemon（bin 入口，内置三模板资产装载）；ready = pidfile + socket 可连。 */
async function bootDaemon(rt: Runtime, sessions?: string): Promise<ChildProcess> {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const binPath = fileURLToPath(new URL("../bin/pi-events-daemon.ts", import.meta.url));
  const pidPath = join(rt.dir, "d.pid");
  const child = spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      "--no-warnings",
      binPath,
      "--sock",
      rt.sockPath,
      "--db",
      rt.dbPath,
      "--pid",
      pidPath,
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
    if (existsSync(pidPath) && existsSync(rt.sockPath)) {
      try {
        const c = await transport.connectEvents(rt.sockPath, { epoch: readEpoch(rt) });
        await c.close();
        return child;
      } catch {
        /* 未监听：继续等 */
      }
    }
    if (Date.now() > deadline) throw new Error("timeout waiting daemon ready");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** epoch 旁车文件（<sock>.epoch，extension client 发现约定票 34/38 对齐点）。 */
const readEpoch = (rt: Runtime): number => {
  if (!existsSync(`${rt.sockPath}.epoch`)) return 0;
  return parseInt(readFileSync(`${rt.sockPath}.epoch`, "utf8").trim(), 10);
};

const connect = async (rt: Runtime): Promise<EventsClient> => {
  const c = await transport.connectEvents(rt.sockPath, { epoch: readEpoch(rt) });
  clients.push(c);
  return c;
};

const stopGracefully = async (child: ChildProcess): Promise<void> => {
  const exit = new Promise<{ code: number | null }>((resolve) => child.once("exit", (code) => resolve({ code })));
  child.kill("SIGTERM");
  const { code } = await exit;
  expect(code).toBe(0); // SIGTERM 优雅退出（票 38 验收面）
};

/** extension 忠实转写（进程外 leg）：wake 通知条目落 transcript → L3 点查收口输入。 */
const transcribeWake = (sessionFile: string, entry: { notificationId: string; verdict: string }, id: string): void => {
  appendFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "custom_message",
      customType: "pi-events.notification",
      content: `billboard: ${entry.notificationId} (${entry.verdict})`,
      details: { notificationId: entry.notificationId, verdict: entry.verdict },
      id,
      parentId: "prev",
      timestamp: new Date().toISOString(),
    })}\n`,
  );
};

describe("票 40 组 1：两段式 ack 双路径 e2e + extension→daemon 全链路", () => {
  it("accepted→verified：session 订阅→probe 翻转→wake 到达→transcript 点查收口（产品级 demo 链）", { timeout: 40_000 }, async () => {
    const rt = makeRuntime();
    const SESSION = "s1";
    const sessionFile = makeSessionFile(rt.dir, SESSION);
    const child = await bootDaemon(rt, JSON.stringify([{ sessionId: SESSION, sessionFile }]));
    const client = await connect(rt);

    const pushes: Array<{ method: string; params: unknown }> = [];
    client.onNotification((method, params) => pushes.push({ method, params }));
    client.startSession(SESSION); // 长连接 = SESSION_START 信号

    // status op：登记处写入（typed 实体签名）——新实体首态走 from=null 首转换，自动发事件（US-13/25）
    const statusRes = (await client.request("status", {
      type: "fixture:widget",
      key: "external/1",
      state: "waiting",
      payload: { demo: "e2e" },
    })) as { entityRef: string; state: string | null; event?: { eventId: string; from: string | null; to: string } };
    expect(statusRes).toMatchObject({
      entityRef: "fixture:widget:external/1",
      state: "waiting",
      event: { eventId: "evt:fixture:widget:external/1#1", from: null, to: "waiting" },
    });

    // subscribe op：真实 checker（文件探针，flag 触发翻转）；schedule 由 wire every 换算
    const flag = join(rt.dir, "flag");
    const subRes = (await client.request("subscribe", {
      entityRef: "fixture:widget:external/1",
      check: `test -f ${flag}`,
      opts: { template: "watch", sessionId: SESSION, on: "passed", schedule: { type: "interval", every: 100 } },
    })) as { subscribed: boolean; subscriptionId: string; entityRef: string; state: string | null; warnings?: string[] };
    expect(subRes).toMatchObject({
      subscribed: true,
      subscriptionId: "sub-0001",
      entityRef: "fixture:widget:external/1",
      state: "waiting",
      warnings: [],
    });

    // probe 翻转（extension→daemon 全链路：pi 会话订阅 → 状态翻转 → wake 注入到达）
    writeFileSync(flag, "ready");
    await waitFor(
      () => pushes.some((p) => p.method === "wake"),
      "wake push 到达（batch 合流窗 2s 为正典节奏）",
    );
    const wake = pushes.find((p) => p.method === "wake")!;
    expect(wake.params).toMatchObject({
      sessionId: SESSION,
      count: 1,
      entries: [{ notificationId: "evt:fixture:widget:external/1#2", entityRef: "fixture:widget:external/1", verdict: "passed" }],
    });

    // 两段式 ack 段一：推送成功簿记 pending→accepted（wake-accepted 正典边）
    await waitFor(() => rt.db.getDelivery("evt:fixture:widget:external/1#2", SESSION)?.state === "accepted", "delivery accepted");
    expect(rt.db.getDelivery("evt:fixture:widget:external/1#2", SESSION)?.state).toBe("accepted");

    // 两段式 ack 段二：extension 忠实转写落 transcript → L3 I9 点查（1s 扫）→ verified
    transcribeWake(sessionFile, { notificationId: "evt:fixture:widget:external/1#2", verdict: "passed" }, "n2");
    await waitFor(() => rt.db.getDelivery("evt:fixture:widget:external/1#2", SESSION)?.state === "verified", "L3 verified");

    // query op：端到端状态可见
    const q = (await client.request("query", { entityRef: "fixture:widget:external/1" })) as {
      entities: Array<{ entityRef: string; state: string | null; backlog?: number }>;
      deadLetters: unknown[];
    };
    expect(q.entities[0]).toMatchObject({ entityRef: "fixture:widget:external/1", state: "passed" });
    expect(q.deadLetters).toEqual([]);

    await stopGracefully(child);
  });

  it("B1 必测①：status 登记→自动发事件全链（US-13/25）：status op 写入 → Transitioned 事件 → fanOut → delivery 行", { timeout: 40_000 }, async () => {
    const rt = makeRuntime();
    const SESSION = "s1";
    const sessionFile = makeSessionFile(rt.dir, SESSION);
    const child = await bootDaemon(rt, JSON.stringify([{ sessionId: SESSION, sessionFile }]));
    const client = await connect(rt);
    const pushes: Array<{ method: string; params: unknown }> = [];
    client.onNotification((method, params) => pushes.push({ method, params }));
    client.startSession(SESSION); // 先活跃：status 驱动的自动事件可直投

    // 前半链：status op 登记 → Transitioned 事件自动发（from=null 首转换）
    const reg = (await client.request("status", { type: "fixture:widget", key: "external/9", state: "waiting" })) as {
      event?: { eventId: string; from: string | null; to: string };
    };
    expect(reg.event).toMatchObject({ eventId: "evt:fixture:widget:external/9#1", from: null, to: "waiting" });

    // 后半链显式认领：订阅在场 + status 状态变更（waiting→failed）→ 自动发事件 → fanOut → delivery 行
    (await client.request("subscribe", {
      entityRef: "fixture:widget:external/9",
      check: "exit 1", // 恒 waiting：探针不产生事件，链路由 status 驱动（与 publish 驱动同管道）
      opts: { template: "watch", sessionId: SESSION, on: "failed", schedule: { type: "interval", every: 60_000 } },
    })) as unknown;
    const change = (await client.request("status", { type: "fixture:widget", key: "external/9", state: "failed" })) as {
      event?: { eventId: string; from: string | null; to: string };
    };
    expect(change.event).toMatchObject({ eventId: "evt:fixture:widget:external/9#2", from: "waiting", to: "failed" });
    // fanOut → delivery 行：status 自动事件与 publish 事件同投递管道；failed 绕行（I2）立即推，
    // 推送成功后两段式段一簿记 pending→accepted（在线 session）
    await waitFor(() => rt.db.getDelivery("evt:fixture:widget:external/9#2", SESSION) !== undefined, "status 自动事件 delivery 行物化（fanOut）");
    await waitFor(() => pushes.some((p) => p.method === "wake"), "status 自动事件 wake push（failed 绕行立即推）");
    await waitFor(() => rt.db.getDelivery("evt:fixture:widget:external/9#2", SESSION)?.state === "accepted", "两段式段一簿记");
    // 票 44：transitioned 沿广播先行于 wake 批（同连接可达）——wake 断言改按 method 定位
    expect(pushes.find((p) => p.method === "wake")).toMatchObject({
      method: "wake",
      params: { sessionId: SESSION, entries: [{ notificationId: "evt:fixture:widget:external/9#2", verdict: "failed" }] },
    });

    await stopGracefully(child);
  });

  it("parked→drain→verified：离线事件 parked→SESSION_START drain→wake→transcript 收口", { timeout: 40_000 }, async () => {
    const rt = makeRuntime();
    const SESSION = "s1";
    const sessionFile = makeSessionFile(rt.dir, SESSION);
    const child = await bootDaemon(rt, JSON.stringify([{ sessionId: SESSION, sessionFile }]));
    const client = await connect(rt);
    // 会话未建立（无 SESSION_START）：先订阅+触发——投递应 parked（E1 正典边）

    (await client.request("status", { type: "fixture:widget", key: "external/1", state: "waiting" })) as unknown;
    const flag = join(rt.dir, "flag");
    (await client.request("subscribe", {
      entityRef: "fixture:widget:external/1",
      check: `test -f ${flag}`,
      opts: { template: "watch", sessionId: SESSION, on: "passed", schedule: { type: "interval", every: 100 } },
    })) as unknown;
    writeFileSync(flag, "ready");
    await waitFor(
      () => rt.db.getDelivery("evt:fixture:widget:external/1#2", SESSION)?.state === "parked",
      "delivery parked（无活跃 session）",
    );

    // SESSION_START：drain（parked→drain-redeliver→accepted）+ snapshot 直推（不吃 batch 窗）
    const pushes: Array<{ method: string; params: unknown }> = [];
    client.onNotification((method, params) => pushes.push({ method, params }));
    client.startSession(SESSION);
    await waitFor(() => pushes.some((p) => p.method === "wake"), "wake push（drain+snapshot）");
    expect(pushes[0]).toMatchObject({
      method: "wake",
      params: { sessionId: SESSION, count: 1, entries: [{ notificationId: "evt:fixture:widget:external/1#2", verdict: "passed" }] },
    });
    await waitFor(() => rt.db.getDelivery("evt:fixture:widget:external/1#2", SESSION)?.state === "accepted", "drain accepted");

    transcribeWake(sessionFile, { notificationId: "evt:fixture:widget:external/1#2", verdict: "passed" }, "n2");
    await waitFor(() => rt.db.getDelivery("evt:fixture:widget:external/1#2", SESSION)?.state === "verified", "L3 verified");

    await stopGracefully(child);
  });
});

describe("票 40 组 2：五条顺序约束端到端断言", () => {
  it("update_hook 唤醒 + Intent 串行 + 缓存提交序 + epoch 拒僵尸（同一 daemon 全链）", { timeout: 40_000 }, async () => {
    const rt = makeRuntime();
    const child = await bootDaemon(rt);
    const client = await connect(rt);

    // --- update_hook 唤醒：publish 断言 → 事件提交回调级联（outbox→fanOut→delivery 同 tick 物化）→ wake 到达 ---
    const pushes: Array<{ method: string; params: unknown }> = [];
    client.onNotification((method, params) => pushes.push({ method, params }));
    client.startSession("sA");
    (await client.request("status", { type: "fixture:order", key: "external/e1", state: "waiting" })) as unknown;
    (await client.request("subscribe", {
      entityRef: "fixture:order:external/e1",
      check: "exit 1", // 恒 waiting：探针不产生事件，翻转由 publish 驱动（agent 断言路径 US-17）
      opts: { template: "watch", sessionId: "sA", on: "passed", schedule: { type: "interval", every: 60_000 } },
    })) as unknown;

    const t0 = Date.now();
    (await client.request("publish", {
      entityRef: "fixture:order:external/e1",
      transition: { to: "passed" }, // passed 不走 failed 绕行（I2）——吃 batch 合流窗，断言窗内投递行在批
    })) as unknown;
    // update_hook 提交回调级联：publish 响应返回时投递行已物化（onWrite→deliverScan→fanOut 同 tick），
    // 且未迁移（batch 窗 2s 未到——推送成功簿记 pending→accepted 归 flush 结算）
    expect(rt.db.getDelivery("evt:fixture:order:external/e1#2", "sA")?.state).toBe("pending");
    await waitFor(() => pushes.some((p) => p.method === "wake"), "wake push");
    expect(Date.now() - t0).toBeLessThan(60_000); // 到达性断言（batch 窗 2s 正典节奏；update_hook 快路径归 A 层细分）
    expect(pushes.find((p) => p.method === "wake")).toMatchObject({
      method: "wake",
      params: { sessionId: "sA", entries: [{ notificationId: "evt:fixture:order:external/e1#2", verdict: "passed" }] },
    });

    // --- Intent 串行：3 个并发 publish 经 L0 队列串行消费——eventSeq 单调、提交序=消费序 ---
    (await client.request("status", { type: "fixture:order", key: "external/e2", state: "waiting" })) as unknown;
    const flips = (["passed", "failed", "passed"] as const).map((to) =>
      client.request("publish", { entityRef: "fixture:order:external/e2", transition: { to } }),
    );
    await Promise.all(flips);
    const e2Events = rt.db
      .outboxBatch(100)
      .filter((r) => r.notificationId.startsWith("evt:fixture:order:external/e2#"))
      .map((r) => ({ notificationId: r.notificationId, event: rt.db.tx((tx) => tx.getEvent(r.notificationId)) }))
      .sort((a, b) => (a.event?.eventSeq ?? 0) - (b.event?.eventSeq ?? 0));
    // 提交序 = 消费序：#1 = status 登记（null→waiting），#2-4 = 并发 publish 依序落账
    expect(e2Events.map((e) => e.event?.to)).toEqual(["waiting", "passed", "failed", "passed"]);
    // eventSeq 全局单调无缺口（双轨写入轨单写者；e1 链先行消费 1-2）
    const seqs = e2Events.map((e) => e.event!.eventSeq);
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0] + i));
    // B1 必测②：seq 双轨单调——eventSeq（store 写入轨）与 decisionOrder（mutation line 决策轨，
    // 内嵌确定性 event id `#N` 尾段）各自严格递增无重复、独立推进（两轨各从自己的真相源断言，互不替代）
    const orders = e2Events.map((e) => {
      const id = e.event!.eventId;
      return Number(id.slice(id.lastIndexOf("#") + 1));
    });
    expect(orders).toEqual(orders.map((_, i) => orders[0] + i)); // decisionOrder 严格递增无重复

    // --- 缓存提交序：publish 全部落账后 query 立即可见已提交终态（缓存投影与提交同步） ---
    const q = (await client.request("query", { entityRef: "fixture:order:external/e2" })) as {
      entities: Array<{ state: string | null }>;
    };
    expect(q.entities[0]?.state).toBe("passed");

    // --- publish 同态语义（ADR 0003）：无 contentIdentity = 无事件；带 contentIdentity = 自转换事件 ---
    const noop = (await client.request("publish", {
      entityRef: "fixture:order:external/e2",
      transition: { to: "passed" },
    })) as { eventSeq: number; from: string | null; to: string };
    expect(noop).toMatchObject({ eventSeq: e2Events[3].event!.eventSeq, from: "passed", to: "passed" });
    expect(
      rt.db.outboxBatch(100).filter((r) => r.notificationId.startsWith("evt:fixture:order:external/e2#")),
    ).toHaveLength(4);
    const selfT = (await client.request("publish", {
      entityRef: "fixture:order:external/e2",
      transition: { to: "passed", contentIdentity: "digest-2" },
    })) as { eventSeq: number; from: string | null; to: string };
    expect(selfT).toMatchObject({ from: "passed", to: "passed" });
    expect(selfT.eventSeq).toBeGreaterThan(e2Events[3].event!.eventSeq);
    expect(
      rt.db.outboxBatch(100).filter((r) => r.notificationId.startsWith("evt:fixture:order:external/e2#")),
    ).toHaveLength(5);

    // --- epoch 拒僵尸（I12，票 119 #118 语义更新）：陈旧世代帧回错误（带期望 epoch）不断连，新世代帧照常应答 ---
    const stale = await transport.connectEvents(rt.sockPath, { epoch: readEpoch(rt) - 1 });
    clients.push(stale);
    let staleError = "";
    await stale
      .request("query", {})
      .catch((e: unknown) => (staleError = String((e as { message?: string })?.message ?? e)));
    expect(staleError).toContain("epoch mismatch"); // 僵尸帧收到诊断性错误（不再静默）
    const fresh = (await client.request("query", {})) as { entities: unknown[] };
    expect(Array.isArray(fresh.entities)).toBe(true); // 正世代服务不受影响

    await stopGracefully(child);
  });

  it("阈值先建者定跨重启：后来者阈值被槽收编（first-creator-wins），重启后仍执政", { timeout: 40_000 }, async () => {
    const rt = makeRuntime();
    const child1 = await bootDaemon(rt);
    const c1 = await connect(rt);
    (await c1.request("status", { type: "fixture:thr", key: "external/1", state: "waiting" })) as unknown;
    const subReq = {
      entityRef: "fixture:thr:external/1",
      check: "exit 2",
      opts: { template: "watch", schedule: { type: "interval", every: 60_000 } },
    };

    // 先建者：failureThreshold 3 定槽
    const sub1 = (await c1.request("subscribe", {
      ...subReq,
      opts: { ...subReq.opts, sessionId: "sA", failureThreshold: 3 },
    })) as { subscribed: boolean; warnings?: string[] };
    expect(sub1.warnings ?? []).toEqual([]);

    // 后来者：failureThreshold 1 —— 被槽收编（先建者定），响应携带 first-creator-wins warning
    const sub2 = (await c1.request("subscribe", {
      ...subReq,
      opts: { ...subReq.opts, sessionId: "sB", failureThreshold: 1 },
    })) as { subscribed: boolean; warnings?: string[] };
    expect(sub2.warnings?.join(" ")).toContain("first-creator-wins");

    await stopGracefully(child1);

    // 跨重启：槽配置（先建者阈值）随 store 重放执政——第三个订阅者仍被收编
    const child2 = await bootDaemon(rt);
    const c2 = await connect(rt);
    const sub3 = (await c2.request("subscribe", {
      ...subReq,
      opts: { ...subReq.opts, sessionId: "sC", failureThreshold: 9 },
    })) as { subscribed: boolean; warnings?: string[] };
    expect(sub3.warnings?.join(" ")).toContain("first-creator-wins");

    // 真相源观测：三行订阅 thresholds 全部 = 先建者 {failureThreshold:3, successThreshold:1}
    const rows = rt.db.querySubscriptions({ entityRefType: "fixture:thr", entityRefKey: "external/1" });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.closedAt).toBeUndefined();
      expect(row.thresholds).toEqual({ failureThreshold: 3, successThreshold: 1 });
    }
    await stopGracefully(child2);
  });
});

describe("票 40 组 3：9 op 面收口（读侧 + cancel/drain/validate/templates/evidence）", () => {
  it("templates 渐进披露 + validate live-run + evidence 指针解引用 + cancel 幂等 + drain 手动触发", { timeout: 40_000 }, async () => {
    const rt = makeRuntime();
    const child = await bootDaemon(rt);
    const client = await connect(rt);

    // templates：内置三模板资产（渐进式披露面，参数说明随定义）
    const tpls = (await client.request("templates", {})) as {
      templates: Array<{ name: string; entityType: string; params: Record<string, string>; states: string[] }>;
    };
    expect(tpls.templates.length).toBeGreaterThanOrEqual(3);
    const dfFree = tpls.templates.find((t) => t.name === "df-free");
    expect(dfFree).toBeDefined();
    expect(dfFree!.entityType).toBe("fs:path");
    expect(dfFree!.params.path).toContain("被监视目录");

    // validate：check 体检 live-run（真执行，三态语义名）
    const vOk = (await client.request("validate", { check: "echo validate-ok" })) as { syntaxOk: boolean; verdict: string; reason: string; warnings: string[] };
    expect(vOk).toMatchObject({ syntaxOk: true, verdict: "passed", reason: "exit 0", warnings: [] });
    const vFail = (await client.request("validate", { check: "exit 2" })) as { verdict: string };
    expect(vFail.verdict).toBe("failed");

    // evidence：指针解引用（票 47：probe evidence 落盘链已接——真链验收：subscribe → probe 回流落盘铸造
    // evidenceRef → 事件旁车 → evidence op 读回全文；billboard 旁车同链断言）
    (await client.request("status", { type: "fixture:ev", key: "external/1", state: "waiting" })) as unknown;
    const subEv = (await client.request("subscribe", {
      entityRef: "fixture:ev:external/1",
      check: "echo evidence-marker-e2e-fulltext",
      opts: { template: "watch", sessionId: "s-ev" },
    })) as { subscriptionId: string };
    expect(subEv.subscriptionId).toMatch(/^sub-/);
    await waitFor(() => rt.db.getEntity("fixture:ev", "external/1")?.state === "passed", "probe flip");
    const evEvent = rt.db
      .outboxBatch(Number.MAX_SAFE_INTEGER)
      .map((r) => rt.db.tx((tx) => tx.getEvent(r.notificationId)!))
      .find((e) => e.entityRefKey === "external/1" && e.to === "passed");
    expect(evEvent?.evidenceRef).toMatch(/^ev:[0-9a-f]{16}$/);
    const ev = (await client.request("evidence", { evidenceRef: evEvent!.evidenceRef })) as {
      content: string;
      truncated: boolean;
    };
    expect(ev.content).toContain("evidence-marker-e2e-fulltext");
    expect(ev.truncated).toBe(false);
    await waitFor(() => rt.db.notifications({}).some((n) => n.eventSeq === evEvent!.eventSeq), "billboard materialize");
    const billboard = JSON.parse(
      rt.db.notifications({}).find((n) => n.eventSeq === evEvent!.eventSeq)!.billboardJson,
    );
    expect(billboard.evidence).toContain("evidence-marker-e2e-fulltext");

    // publish 路径事件（无 evidence 源）不携带指针；直接 ref 命中 + 未找到拒绝仍成立
    (await client.request("status", { type: "fixture:op", key: "external/e1", state: "waiting" })) as unknown;
    (await client.request("publish", { entityRef: "fixture:op:external/e1", transition: { to: "passed" } })) as unknown;
    const pubEvent = rt.db.tx((tx) => tx.getEvent("evt:fixture:op:external/e1#1"));
    expect(pubEvent?.evidenceRef).toBeUndefined();
    await expect(client.request("evidence", { evidenceRef: "evt:fixture:op:external/e1#999" })).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("evidence not found"),
    });

    // cancel：幂等（未知/已关 → false 不抛错）
    const sub = (await client.request("subscribe", {
      entityRef: "fixture:op:external/e1",
      check: "exit 1",
      opts: { template: "watch", sessionId: "s5", schedule: { type: "interval", every: 60_000 } },
    })) as { subscriptionId: string };
    expect(await client.request("cancel", { subscriptionId: sub.subscriptionId })).toEqual({ cancelled: true });
    expect(await client.request("cancel", { subscriptionId: sub.subscriptionId })).toEqual({ cancelled: false });
    expect(await client.request("cancel", { subscriptionId: "sub-9999" })).toEqual({ cancelled: false });

    // drain：手动触发（无 parked 行 → 空摘要；oldestAge ms 单位）
    expect(await client.request("drain", { sessionId: "ghost" })).toEqual({
      drained: 0,
      deadLetterSummary: { count: 0, oldestAge: 0 },
    });

    await stopGracefully(child);
  });
});
