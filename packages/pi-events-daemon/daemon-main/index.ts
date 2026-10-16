/**
 * daemon-main — 组合根（票 38）。可执行前端在 bin/pi-events-daemon.ts（真 adapter + 信号生命周期），
 * 本文件只做两种行为：bootstrap 顺序编排 + 崩溃自愈编排（模块 spec 豁免纪律）。
 *
 * bootstrap 正典顺序（#31，逐项落验收）：
 *   flock 获取 → pidfile 写入 → epoch 生成 → Store 打开（WAL）→ profile 注册表装载
 *   → transcript 后端自检（失败 → 降级运行，C1）→ probe completion queue 创建
 *   （wiring 持有注入 prober 与 loops 两端）→ run_ledger 对账 → startLoops → transport serve。
 *
 * 组合根禁令：只 import 各模块入口（depcruise eda-daemon-main-composition），不长业务；
 * A 层禁 node IO（eda-a-layer-no-direct-io）——fs/锁原语经 fx（FileLock/NodeFs）。
 */
import {
  FileLock,
  NodeFs,
  ShellExec,
  SystemClock,
  defaultPidPath,
  type Clock,
  type Exec,
  type Fs,
  type Pusher,
} from "../fx/index.ts";
import { ProfileRegistry } from "../profiles/index.ts";
import { validateValue, type OpRequestFrame } from "../protocol/index.ts";
import {
  createTranscriptAdapter,
  type SelfCheckResult,
  type SessionRef,
  type TranscriptAdapter,
} from "../transcript-adapter/index.ts";
import { startLoops, type LoopsHandle } from "../loops/index.ts";
import { serve, resolveSocketPath, type TransportHandle } from "../transport/index.ts";
import { SqliteStore, defaultStorePath, type RunLedgerRow, type Store } from "../store.ts"; // 根入口（re-export index+sqlite：SqliteStore 在 sqlite.ts）

/** 启动步骤名（验收观测面；顺序 = 正典顺序）。lock+pidfile 由 O_EXCL 原子一步承载，两步各记其位。 */
export type BootstrapStep =
  | "lock"
  | "pidfile"
  | "epoch"
  | "store"
  | "profiles"
  | "selfcheck"
  | "queue"
  | "ledger"
  | "loops"
  | "serve";

/** 可注入锁面（缺省 fx.FileLock；测试/宿主可替身）。 */
export interface PidLock {
  acquire(): void;
  release(): void;
}

export interface BootstrapOptions {
  /** socket 路径（缺省 PI_EVENTS_SOCK env 优先，否则正典运行时目录）。 */
  sockPath?: string;
  /** store 路径（缺省 ~/.pi/data/pi-events/store.db，WAL）。store 注入时忽略。 */
  dbPath?: string;
  /** pidfile 路径（缺省 ~/.pi/run/pi-events-daemon.pid）。lock 注入时忽略。 */
  pidPath?: string;
  /** 单活仲裁锁（缺省 fx.FileLock O_EXCL pidfile）。 */
  lock?: PidLock;
  /** Store 注入（测试；缺省 SqliteStore）。 */
  store?: Store;
  /** profile 资产（bin/调用方预读 templates/*.json；缺省空注册表）。 */
  profileAssets?: readonly unknown[];
  /** Profile JSON Schema 文档（D1a 校验注入；提供了 assets 就必须提供 schema，拒绝无契约装载）。 */
  profileSchema?: object;
  /** transcript 判别 settings 信号路径（缺省无信号 = 全 JSONL 最保守路径）。 */
  settingsPath?: string;
  /** 启动即注册的 session（自检/L3 verify 面；delivery sessionId → SessionRef 映射）。 */
  sessionRefs?: readonly SessionRef[];
  /** fx 端口替身（缺省真实现：SystemClock/ShellExec/NodeFs）。 */
  clock?: Clock;
  exec?: Exec;
  fs?: Fs;
  /** L2 推送出口（缺省桥接 transport broadcastWake）。 */
  pusher?: Pusher;
  /** 启动步骤观测（验收面）。 */
  onStep?: (step: BootstrapStep) => void;
}

export interface DaemonHandle {
  /** I12 本实例世代（transport 帧校验与 run_ledger 行共用，getEpoch 单源）。 */
  readonly epoch: number;
  readonly steps: readonly BootstrapStep[];
  /** C1 自检结果：ok=false = 降级运行（推送即 accepted，L3 停点查；loops 内建复查门）。 */
  readonly selfCheck: SelfCheckResult;
  /** run_ledger 对账快照（startLoops 归零重探前的账面审计）。 */
  readonly runLedger: readonly RunLedgerRow[];
  readonly loops: LoopsHandle;
  readonly transport: TransportHandle;
  readonly store: Store;
  readonly pidPath: string;
  /** 优雅停机：关 socket → 停循环（L0 队列关闭/定时器取消）→ 关 store → 释锁。幂等；
   *  并发调用共享同一 shutdown promise；单阶段异常收集后统一抛（AggregateError）。 */
  stop(): Promise<void>;
}

/**
 * 组合根入口。任何一步失败：已获资源逆序回收（store/lock）后原样上抛——pidfile/socket 不泄漏，
 * 双启动拒绝与 listen 失败（EACCES/ENOENT 透传）都不留半启动状态。
 */
export async function bootstrap(opts: BootstrapOptions = {}): Promise<DaemonHandle> {
  const steps: BootstrapStep[] = [];
  const step = (s: BootstrapStep): void => {
    steps.push(s);
    opts.onStep?.(s);
  };

  // --- 1+2. flock 获取 → pidfile 写入（O_EXCL 创建 = 仲裁+pid 记录原子步；冲突报持有者状态）---
  const pidPath = opts.pidPath ?? defaultPidPath();
  const lock = opts.lock ?? new FileLock(pidPath);
  lock.acquire();

  let store: Store | null = null;
  let loops: LoopsHandle | null = null;
  let transport: TransportHandle | null = null;
  try {
    // onStep 观测回调在锁保护区内调（评审 M）：回调抛错走下方 catch 逆序回收，锁不泄漏
    step("lock");
    step("pidfile");

    // --- 3. epoch 生成（每次成功启动新值；transport 帧校验与 run_ledger 共用，getEpoch 单源）---
    const epoch = Date.now();
    step("epoch");

    // --- 4. Store 打开（SqliteStore WAL；~/.pi/data/pi-events/store.db 构造注入）---
    store = opts.store ?? new SqliteStore(opts.dbPath ?? defaultStorePath());
    step("store");

    // --- 5. profile 注册表装载（profiles → kernel 注入，I-01）---
    const registry = new ProfileRegistry({ validate: validateValue, schema: opts.profileSchema ?? {} });
    if ((opts.profileAssets?.length ?? 0) > 0 && opts.profileSchema === undefined) {
      throw new Error("bootstrap rejected: profileAssets 提供 时必须同时提供 profileSchema（D1a 契约注入，拒绝无契约装载）");
    }
    for (const asset of opts.profileAssets ?? []) registry.load(asset);
    step("profiles");

    // --- 6. transcript 后端自检（C1）：失败 → 降级运行（推送即 accepted，L3 停点查），不阻断启动 ---
    const fs = opts.fs ?? new NodeFs();
    const adapter: TranscriptAdapter = createTranscriptAdapter(
      fs,
      opts.settingsPath !== undefined ? { settingsPath: opts.settingsPath } : undefined,
    );
    const refBySession = new Map<string, SessionRef>();
    for (const ref of opts.sessionRefs ?? []) {
      await adapter.registerSession(ref);
      if (ref.sessionId !== undefined) refBySession.set(ref.sessionId, ref);
    }
    const selfCheck = await adapter.selfCheck(); // 失败置全局降级标志；启动继续（降级运行正典语义）
    step("selfcheck");

    // --- 7. probe completion queue 两端持有：loops 端 = LoopsHandle.ingestProbeResult（startLoops
    //     内建 Prober onResult 接线），prober 端 = ctx.exec 执行回流——组合根只持 ctx 面。---
    step("queue");

    // L2 推送桥：loops assembleLine 信封（{sessionId,count,entries}）透传为 wake 通知载荷
    // （组合根胶水，无裁决；serve 前到达的 push 拒绝 → loops 退避重试路径）。
    const pusher: Pusher = opts.pusher ?? {
      push: (line: string) => {
        if (!transport) return Promise.reject(new Error("transport not serving yet"));
        let params: unknown = line;
        try {
          params = JSON.parse(line);
        } catch {
          /* 非信封行原样透传 */
        }
        transport.broadcastWake("wake", params);
        return Promise.resolve();
      },
    };

    // --- 8. run_ledger 对账：startLoops 归零重探（D13/A5）前的账面快照（可观测 + 审计面）---
    const runLedger = store.listRunLedger();
    step("ledger");

    // --- 9. startLoops（全部 adapter 装进 ctx；kernel 由 startLoops 私有构造，票 25 裁定）---
    loops = startLoops({
      clock: opts.clock ?? new SystemClock(),
      exec: opts.exec ?? new ShellExec(),
      pusher,
      fs,
      store,
      states: registry.states(),
      registry: registry.entries(),
      ownerEpoch: epoch,
      transcript: { adapter, sessionRefOf: (sessionId) => refBySession.get(sessionId) },
    });
    step("loops");

    // --- 10. transport serve（listen 失败经 ready promise 透传；epoch 门 getEpoch 共用）---
    // 票 40 接线点：9 op → kernel 结果面（L0 唯一写者经 submit 无返回值，op 契约结果管道归终票）。
    // 本票帧必达 epoch 门（I12 已验）；op 面显式报错不静默。
    const dispatch = (frame: OpRequestFrame): never => {
      throw { code: -32601, message: `op "${frame.op}" dispatch 未接线（票 40 全链路收口）；长连接 session_start/推送与自愈面已可用` };
    };
    transport = serve(opts.sockPath ?? resolveSocketPath(), {
      dispatch,
      getEpoch: () => epoch,
      // 长连接建立 = SESSION_START 信号：注册进 L0 队列（drain+snapshot 触发点，票 27/29）
      onSessionStart: (sessionId) => loops!.sessionStart(sessionId),
      // 断连 = SESSION_END：从活跃面注销（评审 M）——fanOut 编址不再含它，pending 行留待重连 drain
      onSessionEnd: (sessionId) => loops!.sessionEnd(sessionId),
    });
    await transport.ready;
    step("serve");

    // 优雅停机（评审 H/M）：并发 stop() 共享同一 shutdown promise（closed ??= doStop，票 29 client 同款）；
    // 每阶段独立 try/catch（errors 收集）——单阶段异常不跳过后续资源，AggregateError 统一抛。
    let closed: Promise<void> | null = null;
    const doStop = async (): Promise<void> => {
      const errors: unknown[] = [];
      try {
        await transport!.close(); // 先关 socket：停新连接/新帧（unlink 在 close 回调内完成）
      } catch (err) {
        errors.push(err);
      }
      try {
        loops!.stop(); // L0 队列关闭 + 全部定时器取消（在途 L0 事务同步消费天然完成）
      } catch (err) {
        errors.push(err);
      }
      try {
        if ("close" in store!) (store as { close(): void }).close(); // SqliteStore 落盘关闭；MemoryStore 无 close
      } catch (err) {
        errors.push(err);
      }
      try {
        lock.release(); // pidfile 移除（重启可立即获锁）
      } catch (err) {
        errors.push(err);
      }
      if (errors.length > 0) throw new AggregateError(errors, "daemon stop incomplete（各阶段已尽力回收）");
    };
    return {
      epoch,
      steps,
      selfCheck,
      runLedger,
      loops,
      transport,
      store,
      pidPath,
      stop: (): Promise<void> => (closed ??= doStop()),
    };
  } catch (err) {
    // 半启动回收：逆序拆已获资源，锁必释（失败重启不留幽灵 pidfile）。
    // transport.close await 完成（unlink 在异步回调里，评审 H）：防替换 daemon bind 撞旧 unlink
    try {
      await transport?.close();
    } catch {
      /* 回收尽力而为 */
    }
    try {
      loops?.stop();
    } catch {
      /* 回收尽力而为 */
    }
    try {
      if (store && "close" in store) (store as { close(): void }).close();
    } catch {
      /* 回收尽力而为 */
    }
    try {
      lock.release();
    } catch {
      /* 回收尽力而为 */
    }
    throw err;
  }
}
