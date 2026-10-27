/**
 * pi-agent-renew smoke suite — run with:
 *   node --experimental-strip-types packages/pi-agent-renew/renew.test.ts
 * (no test framework dependency; assertions + process.exit)
 *
 * Covers the window state machine against the incidents that shaped it:
 *   2026-10-21 regen-gov — waitForIdle races the instruction turn (run-start latch)
 *   2026-10-27 lead      — module-level flags invisible across execution paths
 *                          (state machine lives in renew.log)
 *   2026-10-27 audit     — LATE_READY must not forge a ready window;
 *                          sessions.log bookkeeping guarded; matchIdentity
 *                          tolerates dangling nulls
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import renewExtension from "./renew.ts";
import { WINDOW_TTL_MS, deriveWindowState, readWindowState, type RenewEvent, type WindowState } from "./renew-store.ts";

const SID = "00000000-0000-7000-8000-000000000000";
const NEW_SID = "99999999-9999-7000-8000-999999999999";

let pass = 0;
let fail = 0;
let notifs: { m: string; l: string }[] = [];

function t(name: string, cond: boolean): void {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}`);
}

function makeEnv(root: string) {
  const adir = join(root, ".agents", "agents", "lead");
  mkdirSync(adir, { recursive: true });
  writeFileSync(
    join(adir, "sessions.log"),
    JSON.stringify({ sessionId: SID, startedAt: "t", endedAt: null, note: "当值" }) + "\n"
  );
  writeFileSync(join(adir, "AGENT.json"), JSON.stringify({ name: "lead", workspace: root, description: "t" }));
  writeFileSync(join(root, ".agents", "SPEC.md"), "## 7. 当值纪律\n1. rule\n");
  return { adir, root };
}

function mkPi() {
  const listeners: Array<() => void> = [];
  const pi: any = {
    registered: {} as Record<string, any>,
    registerTool(tool: any) {
      this.registered[tool.name] = tool;
    },
    registerCommand(name: string, cmd: any) {
      this.registered["cmd:" + name] = cmd;
    },
    sendUserMessage() {},
    on(_ev: string, fn: any) {
      listeners.push(fn); // capture the extension's real agent_start listener
    },
  };
  renewExtension(pi);
  pi.sendUserMessage = (_m: string) => {
    // simulate the instruction turn actually starting: fire agent_start listeners
    for (const fn of listeners) void (fn as any)({}, {});
  };
  return pi;
}

function mkCtx(root: string, adir: string, over: any = {}) {
  return {
    mode: "tui",
    cwd: root,
    sessionManager: {
      getSessionFile: () => `/tmp/s_${SID}.jsonl`,
      getSessionId: () => SID,
    },
    waitForIdle: async () => {
      writeFileSync(join(adir, "STATE.md"), "# S\n\n## 交接附言\n本届完成 A/B/C，未完成 D，下一届第一动作 E，隐性知识见 docs/x.md。\n");
    },
    newSession: async (o: any) => {
      await o.withSession({
        sessionManager: { getSessionFile: () => `/tmp/s_${NEW_SID}.jsonl`, getSessionId: () => NEW_SID },
        sendUserMessage: () => {},
      });
      return { cancelled: false };
    },
    ui: { notify: (m: string, l: string) => notifs.push({ m, l }) },
    ...over,
  };
}

const evtTypes = (adir: string) =>
  readFileSync(join(adir, "renew.log"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l).type);

// ---------- A: normal renewal ----------
{
  const root = mkdtempSync(join(tmpdir(), "renew-A-"));
  const { adir, root: _r } = makeEnv(root);
  const pi = mkPi();
  const orig = pi.sendUserMessage.bind(pi);
  pi.sendUserMessage = (m: string) => {
    orig(m);
    pi.registered["agent-renew-ready"].execute("t", {}, undefined, undefined, {
      cwd: root,
      sessionManager: { getSessionId: () => SID },
    });
  };
  await pi.registered["cmd:renew"].handler("", mkCtx(root, adir));
  t("A START→READY→DONE + sessions.log 双写", JSON.stringify(evtTypes(adir)) === JSON.stringify(["START", "READY", "DONE"]) && readFileSync(join(adir, "sessions.log"), "utf8").split("\n").filter((l) => l.trim()).length === 2);
}

// ---------- B: true concurrent re-entry refused ----------
{
  const root = mkdtempSync(join(tmpdir(), "renew-B-"));
  const { adir, root: _r } = makeEnv(root);
  const pi = mkPi();
  notifs = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h1 = pi.registered["cmd:renew"].handler(
    "",
    mkCtx(root, adir, {
      waitForIdle: async () => {
        writeFileSync(join(adir, "STATE.md"), "# S\n\n## 交接附言\n本届完成 A/B/C，未完成 D，下一届第一动作 E，隐性知识见 docs/x.md。\n");
        await gate;
      },
    })
  );
  await new Promise((r) => setTimeout(r, 150));
  await pi.registered["cmd:renew"].handler(
    "",
    mkCtx(root, adir, { waitForIdle: async () => { throw new Error("unreachable"); } })
  );
  t("B 双击被拒", notifs.some((n) => n.l === "error" && n.m.includes("换届拒绝")));
  release();
  await h1;
}

// ---------- C: stale foreign window taken over ----------
{
  const root = mkdtempSync(join(tmpdir(), "renew-C-"));
  const { adir, root: _r } = makeEnv(root);
  writeFileSync(
    join(adir, "renew.log"),
    JSON.stringify({ type: "START", ts: new Date(Date.now() - 60_000).toISOString(), sessionId: "deadbeef-0000-7000-8000-000000000000" }) + "\n"
  );
  const pi = mkPi();
  notifs = [];
  const orig = pi.sendUserMessage.bind(pi);
  pi.sendUserMessage = (m: string) => {
    orig(m);
    pi.registered["agent-renew-ready"].execute("t", {}, undefined, undefined, {
      cwd: root,
      sessionManager: { getSessionId: () => SID },
    });
  };
  await pi.registered["cmd:renew"].handler("", mkCtx(root, adir));
  t("C TAKEOVER 后走完", notifs.some((n) => n.m.includes("换届接管")) && evtTypes(adir).slice(-1)[0] === "DONE");
}

// ---------- D: READY then ABORT → resume on re-entry ----------
{
  const root = mkdtempSync(join(tmpdir(), "renew-D-"));
  const { adir, root: _r } = makeEnv(root);
  const pi = mkPi();
  await pi.registered["cmd:renew"].handler(
    "",
    mkCtx(root, adir, {
      // agent calls ready but never fixes the note even after guidance —
      // corrective retry runs, second READY fires, final ABORT
      waitForIdle: async () => {
        writeFileSync(join(adir, "STATE.md"), "# S\n\n## 交接附言\n（本届在写）\n");
        pi.registered["agent-renew-ready"].execute("t", {}, undefined, undefined, {
          cwd: root,
          sessionManager: { getSessionId: () => SID },
        });
      },
    })
  );
  const e1 = evtTypes(adir);
  t("D1 指导重试仍失败 → ABORT", e1.filter((x) => x === "READY").length >= 2 && e1[e1.length - 1] === "ABORT");
  writeFileSync(join(adir, "STATE.md"), "# S\n\n## 交接附言\n本届完成 A/B/C，未完成 D，下一届第一动作 E，隐性知识见 docs/x.md。\n");
  notifs = [];
  await pi.registered["cmd:renew"].handler(
    "",
    mkCtx(root, adir, { waitForIdle: async () => { throw new Error("resume skips instruction"); } })
  );
  t("D2 续办直达换届", notifs.some((n) => n.m.includes("换届续办")) && readFileSync(join(adir, "sessions.log"), "utf8").split("\n").filter((l) => l.trim()).length === 2);
}

// ---------- E: no ready → abort ----------
{
  const root = mkdtempSync(join(tmpdir(), "renew-E-"));
  const { adir, root: _r } = makeEnv(root);
  const pi = mkPi();
  notifs = [];
  await pi.registered["cmd:renew"].handler("", mkCtx(root, adir));
  t("E 无 ready 被 ABORT", notifs.some((n) => n.l === "error" && n.m.includes("换届中止")) && evtTypes(adir).slice(-1)[0] === "ABORT");
}

// ---------- F: audit HIGH-1 — LATE_READY must not forge a window ----------
{
  const root = mkdtempSync(join(tmpdir(), "renew-F-"));
  const { adir, root: _r } = makeEnv(root);
  const pi = mkPi();
  // agent calls ready out-of-window (e.g. after the handler already aborted)
  const r = await pi.registered["agent-renew-ready"].execute("t", {}, undefined, undefined, {
    cwd: root,
    sessionManager: { getSessionId: () => SID },
  });
  t("F1 窗口外调用返回错误", r.details.ok === false);
  t("F2 事件类型是 LATE_READY 非 READY", evtTypes(adir).slice(-1)[0] === "LATE_READY");
  // next /renew must open a FRESH window: it re-sends the instruction
  // (a forged resume would skip sendUserMessage entirely)
  notifs = [];
  let instructionSent = 0;
  const origSend = pi.sendUserMessage.bind(pi);
  pi.sendUserMessage = (m: string) => {
    instructionSent++;
    origSend(m);
  };
  await pi.registered["cmd:renew"].handler("", mkCtx(root, adir));
  // a forged resume would notify "换届续办" and skip sendUserMessage entirely;
  // correct behavior: fresh instruction sent, no resume notification
  t("F3 LATE_READY 不产生续办（重新发指令）", notifs.some((n) => n.m.includes("换届开始")) && instructionSent >= 1 && !notifs.some((n) => n.m.includes("换届续办")));
}

// ---------- G: audit HIGH-3 — bookkeeping guards ----------
{
  const root = mkdtempSync(join(tmpdir(), "renew-G-"));
  const { adir, root: _r } = makeEnv(root);
  const pi = mkPi();
  const orig = pi.sendUserMessage.bind(pi);
  pi.sendUserMessage = (m: string) => {
    orig(m);
    pi.registered["agent-renew-ready"].execute("t", {}, undefined, undefined, {
      cwd: root,
      sessionManager: { getSessionId: () => SID },
    });
  };
  // corrupt the sessions.log row so closeOnDutyEntry's ownership check fires —
  // the renewal must still complete (ABORT logged as LEDGER STALE) and the
  // prompt must still reach the new session.
  const ctx = mkCtx(root, adir, {
    newSession: async (o: any) => {
      writeFileSync(join(adir, "sessions.log"), JSON.stringify({ sessionId: "tampered-0000-7000-8000-000000000000", startedAt: "t", endedAt: null, note: "被并发篡改" }) + "\n");
      await o.withSession({
        sessionManager: { getSessionFile: () => `/tmp/s_${NEW_SID}.jsonl`, getSessionId: () => NEW_SID },
        sendUserMessage: () => {},
      });
      return { cancelled: false };
    },
  });
  await pi.registered["cmd:renew"].handler("", ctx);
  const evts = evtTypes(adir);
  t("G 属主校验拦截盲改 + LEDGER STALE 落账", evts.includes("ABORT") && evts[evts.length - 1] === "DONE");
}

// ---------- H: audit MEDIUM-7 — dangling nulls tolerated ----------
{
  const root = mkdtempSync(join(tmpdir(), "renew-H-"));
  const adir = join(root, ".agents", "agents", "lead");
  mkdirSync(adir, { recursive: true });
  // two dangling nulls from dead predecessors, then the live one
  writeFileSync(
    join(adir, "sessions.log"),
    [
      JSON.stringify({ sessionId: "01a143b4-0000-7000-8000-000000000000", startedAt: "t1", endedAt: null, note: "悬空1" }),
      JSON.stringify({ sessionId: "01a15d1e-0000-7000-8000-000000000000", startedAt: "t2", endedAt: null, note: "悬空2" }),
      JSON.stringify({ sessionId: SID, startedAt: "t3", endedAt: null, note: "当值" }),
    ].join("\n") + "\n"
  );
  writeFileSync(join(adir, "AGENT.json"), JSON.stringify({ name: "lead", workspace: root, description: "t" }));
  writeFileSync(join(root, ".agents", "SPEC.md"), "## 7. x\n1. r\n");
  const pi = mkPi();
  notifs = [];
  const orig = pi.sendUserMessage.bind(pi);
  pi.sendUserMessage = (m: string) => {
    orig(m);
    pi.registered["agent-renew-ready"].execute("t", {}, undefined, undefined, {
      cwd: root,
      sessionManager: { getSessionId: () => SID },
    });
  };
  await pi.registered["cmd:renew"].handler("", mkCtx(root, adir));
  t("H 悬空 null 不阻塞当值匹配", notifs.some((n) => n.m.includes("换届开始")) && evtTypes(adir).slice(-1)[0] === "DONE");
}

// ---------- I: validation failure → corrective guidance → agent fixes → success ----------
{
  const root = mkdtempSync(join(tmpdir(), "renew-I-"));
  const { adir, root: _r } = makeEnv(root);
  const pi = mkPi();
  notifs = [];
  let guidance: string = "";
  const origSend = pi.sendUserMessage.bind(pi);
  // first instruction: agent runs checklist but writes placeholder note; after
  // the corrective guidance arrives, it fixes the note and calls ready.
  let round = 0;
  pi.sendUserMessage = (m: string) => {
    if (m.includes("换届校验未通过")) {
      guidance = m;
      // agent fixes the note in response to guidance
      writeFileSync(join(adir, "STATE.md"), "# S\n\n## 交接附言（给下一届 lead）\n本届完成 A/B/C，未完成 D，下一届第一动作 E。隐性知识见 docs/x.md。\n");
      pi.registered["agent-renew-ready"].execute("t", {}, undefined, undefined, {
        cwd: root,
        sessionManager: { getSessionId: () => SID },
      });
    } else {
      // initial instruction: agent does checklist, writes placeholder note, AND
      // calls ready (premature confirmation — exactly the 10-27 lead pattern)
      writeFileSync(join(adir, "STATE.md"), "# S\n\n## 交接附言\n（本届在写）\n");
      pi.registered["agent-renew-ready"].execute("t", {}, undefined, undefined, {
        cwd: root,
        sessionManager: { getSessionId: () => SID },
      });
    }
    round++;
    origSend(m);
  };
  await pi.registered["cmd:renew"].handler("", mkCtx(root, adir, { waitForIdle: async () => {} }));
  t("I1 校验失败后发送了修正指导", guidance.includes("交接附言"));
  t("I2 修正后换届成功", evtTypes(adir).slice(-1)[0] === "DONE" && notifs.some((n) => n.m.includes("换届修正生效")));
}

// ---------- table-driven: deriveWindowState 纯函数 7 分支 ----------
{
  const T0 = "2026-10-27T00:00:00.000Z";
  const T1 = "2026-10-27T00:01:00.000Z";
  const T0ms = Date.parse(T0);
  const ev = (type: RenewEvent["type"], ts: string, sessionId = SID): RenewEvent => ({ type, ts, sessionId });
  const stateEq = (a: WindowState, b: WindowState) =>
    a.open === b.open && a.ready === b.ready && a.ownerSessionId === b.ownerSessionId &&
    a.startedAt === b.startedAt && a.ageMs === b.ageMs && a.resumable === b.resumable;
  const CLOSED: WindowState = { open: false, ready: false, ownerSessionId: null, startedAt: null, ageMs: null, resumable: false };
  const rows: Array<{ name: string; events: RenewEvent[]; now: number; want: WindowState }> = [
    { name: "T1 空事件数组 → closed", events: [], now: T0ms, want: CLOSED },
    { name: "T2 尾部 START 未过期 → open 未 ready，owner=START.sessionId", events: [ev("START", T0)], now: T0ms + 1000, want: { open: true, ready: false, ownerSessionId: SID, startedAt: T0, ageMs: 1000, resumable: false } },
    { name: "T3 尾部 READY → open+ready，owner=开局 START.sessionId", events: [ev("START", T0), ev("READY", T1)], now: Date.parse(T1) + 500, want: { open: true, ready: true, ownerSessionId: SID, startedAt: T0, ageMs: 60500, resumable: false } },
    { name: "T4a 尾部 DONE → closed", events: [ev("START", T0), ev("READY", T1), ev("DONE", T1)], now: T0ms, want: CLOSED },
    { name: "T4b 尾部 CANCELLED → closed", events: [ev("START", T0), ev("READY", T1), ev("CANCELLED", T1)], now: T0ms, want: CLOSED },
    { name: "T5a ABORT 段内有 READY → resumable", events: [ev("START", T0), ev("READY", T1), ev("ABORT", T1)], now: T0ms, want: { open: false, ready: false, ownerSessionId: SID, startedAt: null, ageMs: null, resumable: true } },
    { name: "T5b ABORT 段内无 READY → 非 resumable", events: [ev("START", T0), ev("ABORT", T1)], now: T0ms, want: CLOSED },
    { name: "T6a TTL 边界内（now-opening < TTL）→ open", events: [ev("START", T0)], now: T0ms + WINDOW_TTL_MS - 1, want: { open: true, ready: false, ownerSessionId: SID, startedAt: T0, ageMs: WINDOW_TTL_MS - 1, resumable: false } },
    { name: "T6b TTL 到期（now-opening ≥ TTL）→ zombie closed（保留推导字段）", events: [ev("START", T0)], now: T0ms + WINDOW_TTL_MS, want: { open: false, ready: false, ownerSessionId: SID, startedAt: T0, ageMs: WINDOW_TTL_MS, resumable: false } },
    { name: "T7a 尾部 LEGACY 被跳过，推导不变", events: [ev("START", T0), { type: "LEGACY", ts: "", sessionId: "" }], now: T0ms + 1000, want: { open: true, ready: false, ownerSessionId: SID, startedAt: T0, ageMs: 1000, resumable: false } },
    { name: "T7b 尾部 LATE_READY 被跳过，不伪造 ready 窗口", events: [ev("START", T0), ev("LATE_READY", T1)], now: T0ms + 1000, want: { open: true, ready: false, ownerSessionId: SID, startedAt: T0, ageMs: 1000, resumable: false } },
    { name: "T7c ABORT 回溯段内夹带 LEGACY/LATE_READY 不中断回溯", events: [ev("START", T0), ev("READY", T1), ev("LATE_READY", T1), { type: "LEGACY", ts: "", sessionId: "" }, ev("ABORT", T1)], now: T0ms, want: { open: false, ready: false, ownerSessionId: SID, startedAt: null, ageMs: null, resumable: true } },
  ];
  for (const r of rows) t(r.name, stateEq(deriveWindowState(r.events, r.now), r.want));
}

// ---------- J: CANCELLED — newSession 被用户取消 ----------
{
  const root = mkdtempSync(join(tmpdir(), "renew-J-"));
  const { adir, root: _r } = makeEnv(root);
  const pi = mkPi();
  notifs = [];
  // agent 在窗口内确认 ready（否则流程在校验阶段就 ABORT，走不到 newSession）
  const orig = pi.sendUserMessage.bind(pi);
  pi.sendUserMessage = (m: string) => {
    orig(m);
    pi.registered["agent-renew-ready"].execute("t", {}, undefined, undefined, {
      cwd: root,
      sessionManager: { getSessionId: () => SID },
    });
  };
  await pi.registered["cmd:renew"].handler("", mkCtx(root, adir, { newSession: async () => ({ cancelled: true }) }));
  const lines = readFileSync(join(adir, "renew.log"), "utf8").split("\n").filter((l) => l.trim());
  const last = JSON.parse(lines[lines.length - 1]);
  t("J1 尾部 CANCELLED 事件且属旧 session", last.type === "CANCELLED" && last.sessionId === SID);
  t("J2 notify 提示换届取消", notifs.some((n) => n.m.includes("换届取消")));
  t("J3 取消后窗口推导为 closed", readWindowState(adir).open === false);
  // 窗口已关：再跑一次 /renew 必须重新走 START（默认 mkCtx 走完整换届）
  await pi.registered["cmd:renew"].handler("", mkCtx(root, adir));
  const types = evtTypes(adir);
  t("J4 重跑 /renew 重新走 START 并完成换届", types[types.indexOf("CANCELLED") + 1] === "START" && types[types.length - 1] === "DONE");
}

// cleanup
for (const d of ["renew-A-", "renew-B-", "renew-C-", "renew-D-", "renew-E-", "renew-F-", "renew-G-", "renew-H-", "renew-I-", "renew-J-"]) {
  try {
    for (const e of (await import("node:fs")).readdirSync(tmpdir())) {
      if (e.startsWith(d)) rmSync(join(tmpdir(), e), { recursive: true, force: true });
    }
  } catch { /* tmp cleanup best effort */ }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
