/**
 * Ticket 45 — 事件 dock：纯逻辑（快照归一/hint 文案/沿环形日志/行格式化）
 * + wake 旁路钩子（onTransitioned / onConnectChange，真 socket）+ EventsDock 组件渲染。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  EDGE_LOG_LIMIT,
  EventsDock,
  dockHint,
  fetchSnapshot,
  formatEdgeLine,
  formatSubRow,
  parseEdge,
  recordEdge,
  startWake,
  type DockSnapshot,
  type OpSender,
} from "../index.ts";
import { startTestDaemon, waitFor, type TestDaemon } from "./harness.ts";

const snap = (over: Partial<DockSnapshot> = {}): DockSnapshot => ({
  connected: true,
  socketPath: "/tmp/eda.sock",
  epoch: 7,
  subs: [],
  parkedTotal: 0,
  deadLetters: 0,
  ...over,
});

describe("票 45：dockHint footer 文案（零副作用纪律 + 计数段）", () => {
  it("无 daemon 接触（null）→ 无段；连接 → 订阅数 + parked；dlq>0 附加段", () => {
    expect(dockHint(null)).toBeUndefined();
    expect(dockHint(snap({ subs: [{ subscriptionId: "a" }, { subscriptionId: "b" }] as never, parkedTotal: 3 })))
      .toBe("⏻ 2 subs · 3 parked");
    expect(dockHint(snap({ parkedTotal: 0, deadLetters: 2 }))).toBe("⏻ 0 subs · 0 parked · 2 dlq");
    expect(dockHint(snap({ connected: false }))).toBe("⏻ events unreachable");
  });
});

describe("票 45：沿环形日志 + 解析守卫", () => {
  it("recordEdge 封顶 EDGE_LOG_LIMIT（纯函数不 mutate）", () => {
    let log: ReturnType<typeof recordEdge> = [];
    for (let i = 0; i < EDGE_LOG_LIMIT + 3; i++) {
      log = recordEdge(log, { entityRef: "x:external/e", from: null, to: "up", eventSeq: i, receivedAt: i });
    }
    expect(log).toHaveLength(EDGE_LOG_LIMIT);
    expect(log[0].eventSeq).toBe(3); // 头部旧沿被挤出
  });
  it("parseEdge 形状不符返回 null（广播契约漂移防御）", () => {
    expect(parseEdge({ entityRef: "x:external/e", to: "up", from: null, eventSeq: 1 })).toMatchObject({ to: "up" });
    expect(parseEdge(null)).toBeNull();
    expect(parseEdge({ to: "up" })).toBeNull(); // 缺 entityRef
  });
});

describe("票 45：fetchSnapshot——query 订阅明细归一（票 44 数据源）+ epoch 旁车", () => {
  it("parked 合计 = 各订阅 backlog 之和；deadLetters 计数；epoch 读旁车文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eda-dock-"));
    const sock = join(dir, "d.sock");
    writeFileSync(`${sock}.epoch`, "42\n");
    const sender: OpSender = async (op, params) => {
      expect(op).toBe("query");
      expect(params).toEqual({ session: "s1" });
      return {
        entities: [],
        deadLetters: [{}, {}],
        subscriptions: [
          { subscriptionId: "a", backlog: 2 },
          { subscriptionId: "b", backlog: 0 },
          { subscriptionId: "c", backlog: 5 },
        ],
      };
    };
    const s = await fetchSnapshot(sender, "s1", sock);
    expect(s.parkedTotal).toBe(7);
    expect(s.deadLetters).toBe(2);
    expect(s.epoch).toBe(42);
    expect(s.connected).toBe(true);
  });
});

describe("票 45：行格式化", () => {
  it("订阅行含实体/现值/on/schedule/backlog；沿行含 from→to 与 seq", () => {
    const row = formatSubRow({
      subscriptionId: "abcdefgh12345678",
      sessionId: "s1",
      entityRef: "k8s:pod/node1-x",
      state: "running",
      origin: "session",
      on: ["running", "failed"],
      schedule: { type: "interval", intervalMs: 60000 },
      backlog: 3,
      createdAt: "",
    });
    expect(row).toContain("k8s:pod/node1-x");
    expect(row).toContain("on=[running,failed]");
    expect(row).toContain("every 60000ms");
    expect(row).toContain("backlog=3");
    const edge = formatEdgeLine({ entityRef: "x:external/e", from: "up", to: "down", eventSeq: 9, receivedAt: 0 });
    expect(edge).toContain("up → down");
    expect(edge).toContain("#9");
  });
});

describe("票 45：wake 旁路钩子（真 socket，票 44 沿广播通道）", () => {
  it("broadcastWake('transitioned') → onTransitioned 收沿；onConnectChange 沿建连/断连触发", async () => {
    const daemon: TestDaemon = startTestDaemon();
    try {
      const edges: unknown[] = [];
      const connectChanges: boolean[] = [];
      const wake = startWake({
        sessionId: "s1",
        socketPath: daemon.socketPath,
        inject: () => {},
        notify: () => {},
        sleep: async () => {},
        onTransitioned: (params) => edges.push(params),
        onEdge: (connected) => connectChanges.push(connected),
      });
      await waitFor(() => wake.isConnected(), "wake connected");
      expect(connectChanges[0]).toBe(true);

      daemon.handle.broadcastWake("transitioned", { kind: "transitioned", entityRef: "x:external/e", from: null, to: "up", eventSeq: 1 });
      await waitFor(() => edges.length === 1, "edge received");
      expect(edges[0]).toMatchObject({ entityRef: "x:external/e", to: "up" });

      await wake.stop();
      await waitFor(() => connectChanges.includes(false), "disconnect edge");
    } finally {
      await daemon.close();
    }
  });
});

describe("票 45：EventsDock 组件渲染", () => {
  const theme = { fg: (_token: string, text: string) => text } as unknown as Theme;
  const tui = { requestRender: () => {} };
  const sub = {
    subscriptionId: "abcdefgh12345678",
    sessionId: "s1",
    entityRef: "k8s:pod/x",
    state: "running",
    origin: "session" as const,
    backlog: 1,
    createdAt: "",
  };

  it("渲染 daemon 行 / 订阅行 / 沿行 / 键位行；r 键触发刷新", async () => {
    let fetches = 0;
    const edge = { entityRef: "x:external/e", from: null, to: "up", eventSeq: 4, receivedAt: 0 };
    const dock = new EventsDock(tui, theme, () => {}, {
      fetchSnapshot: async () => {
        fetches++;
        return snap({ subs: [sub], parkedTotal: 1 });
      },
      edges: () => [edge],
      initial: null,
    });
    await new Promise((r) => setTimeout(r, 10)); // 初始异步刷新落地
    const lines = dock.render(100).join("\n");
    expect(lines).toContain("pi-events dock");
    expect(lines).toContain("epoch 7");
    expect(lines).toContain("k8s:pod/x");
    expect(lines).toContain("x:external/e ∅ → up (#4)");
    expect(lines).toContain("r 刷新");
    dock.handleInput("r");
    await new Promise((r) => setTimeout(r, 10));
    expect(fetches).toBe(2);

    let closed = false;
    const dock2 = new EventsDock(tui, theme, () => {
      closed = true;
    }, { fetchSnapshot: async () => snap(), edges: () => [], initial: snap() });
    dock2.handleInput("q");
    expect(closed).toBe(true);
  });

  it("快照失败 → 面板不关闭，错误行呈现 + connected 降级", async () => {
    const dock = new EventsDock(tui, theme, () => {}, {
      fetchSnapshot: async () => {
        throw new Error("socket gone");
      },
      edges: () => [],
      initial: snap({ subs: [sub] }),
    });
    await new Promise((r) => setTimeout(r, 10));
    const lines = dock.render(100).join("\n");
    expect(lines).toContain("socket gone");
    expect(dock.render(100).join("\n")).toContain("unreachable");
  });
});
