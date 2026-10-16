/**
 * 测试 harness — 最小 daemon 组合根替身（票 35 声明链 e2e / 票 36 wake 真 socket）。
 *
 * serve（transport）+ MemoryStore + startLoops + Pusher→broadcastWake 适配。
 * 这正是票 38 daemon-main 将要做的组合（方法名 "wake" 与 envelope {sessionId, count, entries}
 * 为 extension 消费面约定）；此处仅测试替身，非产品实现。
 * 组合根替身内的简化（注记）：subscribe dispatch 直接 putEntity + loops.submit subscribe——
 * register/status 归 daemon-main op 映射票。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, connectEvents, type TransportHandle, type EventsClient } from "pi-events-daemon/transport.ts";
import { createMemoryStore, type Store } from "pi-events-daemon/store.ts";
import { startLoops, type LoopsCtx, type LoopsHandle } from "pi-events-daemon/loops.ts";
import { FakeExec, type Pusher } from "pi-events-daemon/fx.ts";
import type { NotificationFrame, OpRequestFrame } from "pi-events-daemon/protocol.ts";

export const EPOCH = 5;

/** wire 单串 → {type, key}：以 (external|project|user)/ 锚点切分（type 可含冒号，如 fs:path）。 */
export function parseWireEntityRef(wire: string): { type: string; key: string } {
  const m = /^(.+):(external|project|user)\/(.+)$/.exec(wire);
  if (!m) throw new Error(`entityRef wire 解析失败: ${wire}`);
  return { type: m[1], key: `${m[2]}/${m[3]}` };
}

export interface TestDaemon {
  socketPath: string;
  dir: string;
  store: Store;
  loops: LoopsHandle;
  handle: TransportHandle;
  /** daemon 侧收到的 subscribe op 参数（声明链断言面）。 */
  subscribeFrames: Array<Record<string, unknown>>;
  /** transport onSessionStart 已触发的 sessionId（注册到达信号；L0 消费 FIFO 在其后提交必见注册）。 */
  sessionStarted: string[];
  close(): Promise<void>;
}

export function startTestDaemon(opts: { store?: Store; socketPath?: string } = {}): TestDaemon {
  const dir = mkdtempSync(join(tmpdir(), "pi-ext-daemon-"));
  const path = opts.socketPath ?? join(dir, "d.sock");
  const store = opts.store ?? createMemoryStore();
  const exec = new FakeExec();
  let handle: TransportHandle | null = null;

  const loopsCtx: LoopsCtx = {
    clock: {
      now: () => Date.now(),
      setTimeout: (fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(t) };
      },
    },
    exec,
    // Pusher 适配（daemon-main 接线预演）：loops 推送行（{sessionId,count,entries} JSON 串）
    // → transport 长连接 notification 帧（method "wake"）。
    pusher: {
      push: async (line: string) => {
        handle?.broadcastWake("wake", JSON.parse(line));
      },
    } as Pusher,
    fs: {
      readFile: async () => {
        throw new Error("harness 未接线 fs.readFile");
      },
      watch: () => ({ close: () => {} }),
    },
    store,
    states: new Set(["passed", "failed", "waiting"]),
    ownerEpoch: EPOCH,
  };
  const loops = startLoops(loopsCtx);

  const subscribeFrames: Array<Record<string, unknown>> = [];
  const sessionStarted: string[] = [];
  handle = serve(path, {
    dispatch: (frame: OpRequestFrame) => {
      if (frame.op === "subscribe") {
        const params = frame.params as { entityRef: string; check: string; opts?: Record<string, unknown> };
        subscribeFrames.push(params as unknown as Record<string, unknown>);
        const ref = parseWireEntityRef(params.entityRef);
        store.putEntity({ type: ref.type, key: ref.key, state: null });
        loops.submit({
          kind: "subscribe",
          req: {
            sessionId: "s1",
            entityRef: ref,
            template: String(params.opts?.template ?? "adhoc"),
            check: params.check,
            now: Date.now(),
            opts: { ...(params.opts ?? {}) } as never,
          },
        });
        return { queued: true };
      }
      return { echoed: frame.op };
    },
    getEpoch: () => EPOCH,
    onSessionStart: (sessionId) => {
      sessionStarted.push(sessionId);
      loops.sessionStart(sessionId); // scope 缺省 project（applySessionStart）
    },
  });

  // epoch 旁车文件（票 34 约定：daemon bootstrap 写，extension 每请求读）
  writeFileSync(`${path}.epoch`, String(EPOCH));

  return {
    socketPath: path,
    dir,
    store,
    loops,
    handle: handle,
    subscribeFrames,
    sessionStarted,
    close: async () => {
      await handle.close();
    },
  };
}

export async function connectWakeClient(daemon: TestDaemon, sessionId: string): Promise<{
  client: EventsClient;
  notifications: NotificationFrame[];
}> {
  const client = await connectEvents(daemon.socketPath, { epoch: EPOCH });
  const notifications: NotificationFrame[] = [];
  client.onNotification((method, params) => {
    notifications.push({ kind: "notification", method, params });
  });
  client.startSession(sessionId);
  return { client, notifications };
}

export const waitFor = async (cond: () => boolean, what = "condition", ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

export { mkdtempSync, rmSync, tmpdir, join, writeFileSync };
