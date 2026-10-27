/**
 * pi-agent-renew — /renew: agent identity generational handover
 * Spec: ~/.agents/agents/SPEC.md (section 6 handover, section 7 on-duty discipline)
 * Flow: identity match -> STATE update -> validate -> prompt + audit file -> newSession + bookkeeping + auto-send.
 *
 * v0.3: window state machine lives in renew.log (structured JSONL event stream),
 *       replacing module-level flags — 2026-10-27 lead incident proved ready/armed
 *       flags written via one execution path were invisible to another (direct
 *       toolCall returned "已确认就绪" while the command handler validated false).
 *       All execution paths (direct toolCall / codemode / concurrent handlers)
 *       now coordinate through a single append-only file on disk.
 *
 * Window model (derived from the tail of renew.log, same read-as-tail philosophy
 * as sessions.log's "last endedAt:null entry = on duty"):
 *   - window open  = last window event ∈ {START, READY, TAKEOVER}, < TTL,
 *                    same owner sessionId as the calling session
 *   - ready        = last window event is READY (appended by the tool)
 *   - terminal     = DONE / ABORT / CANCELLED closes the window, nothing to delete
 *   - ownership    = caller sessionId == window sessionId
 *       ├─ no file / no open window        → open
 *       ├─ open window, owner ≠ caller    → takeover (dead predecessor's window)
 *       ├─ open window, owner = caller, <TTL → refuse (true concurrent re-entry)
 *       └─ open window, owner = caller, ≥TTL → takeover (own zombie window)
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const WINDOW_TTL_MS = 30 * 60 * 1000; // same-owner re-entry freshness (user-approved)

// ---------- renew.log event stream (the window state machine) ----------

interface RenewEvent {
  type: "START" | "READY" | "LATE_READY" | "TAKEOVER" | "DONE" | "ABORT" | "CANCELLED" | "LEGACY";
  ts: string; // ISO
  sessionId: string; // owner of the window / actor of the event
  detail?: string;
  newSessionId?: string;
  handoffFile?: string;
}

function renewLogPath(agentDir: string): string {
  return join(agentDir, "renew.log");
}

function appendRenewEvent(agentDir: string, ev: Omit<RenewEvent, "ts">): void {
  const full: RenewEvent = { ...ev, ts: new Date().toISOString() };
  const body = readFileSyncSafe(renewLogPath(agentDir));
  const needsNewline = body.length > 0 && !body.endsWith("\n");
  appendFileSync(renewLogPath(agentDir), (needsNewline ? "\n" : "") + JSON.stringify(full) + "\n");
}

function readFileSyncSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** Parse renew.log tolerantly: JSON lines with {type,...}; legacy free-text lines become LEGACY. */
function parseRenewLog(agentDir: string): RenewEvent[] {
  const lines = readFileSyncSafe(renewLogPath(agentDir)).split("\n").filter((l) => l.trim());
  const events: RenewEvent[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (typeof e.type === "string" && typeof e.ts === "string") {
        events.push(e as RenewEvent);
      } else {
        events.push({ type: "LEGACY", ts: "", sessionId: "" });
      }
    } catch {
      events.push({ type: "LEGACY", ts: "", sessionId: "" }); // v0.2 free-text lines
    }
  }
  return events;
}

const TERMINAL_TYPES = new Set(["DONE", "ABORT", "CANCELLED"]);

interface WindowState {
  open: boolean;
  ready: boolean;
  ownerSessionId: string | null;
  startedAt: string | null;
  ageMs: number | null;
  /** last window segment (START..ABORT) reached READY — a later /renew with
   *  non-placeholder handoff note can resume instead of re-instructing. */
  resumable: boolean;
}

/** Derive the current window state from the tail of renew.log. */
function readWindowState(agentDir: string): WindowState {
  const events = parseRenewLog(agentDir);
  // Locate the last non-LEGACY event; window semantics:
  //   tail = READY | START | TAKEOVER      → window open (ready iff tail is READY)
  //   tail = DONE | CANCELLED              → closed
  //   tail = ABORT                         → closed; resumable iff the same
  //                                          segment (back to the previous
  //                                          terminal/opening event) had a READY
  let last = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t !== "LEGACY" && t !== "LATE_READY") {
      last = i;
      break;
    }
  }
  if (last < 0) {
    return { open: false, ready: false, ownerSessionId: null, startedAt: null, ageMs: null, resumable: false };
  }
  const lastEv = events[last];
  if (TERMINAL_TYPES.has(lastEv.type)) {
    if (lastEv.type === "ABORT") {
      let sawReady = false;
      for (let i = last - 1; i >= 0; i--) {
        const e = events[i];
        if (e.type === "LEGACY" || e.type === "LATE_READY") continue;
        if (e.type === "READY") {
          sawReady = true;
          continue;
        }
        break; // segment boundary (opening or earlier terminal)
      }
      if (sawReady) {
        return { open: false, ready: false, ownerSessionId: lastEv.sessionId || null, startedAt: null, ageMs: null, resumable: true };
      }
    }
    return { open: false, ready: false, ownerSessionId: null, startedAt: null, ageMs: null, resumable: false };
  }
  // open window: tail is READY or START/TAKEOVER
  const ready = lastEv.type === "READY";
  let opening = lastEv;
  if (ready) {
    for (let i = last - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "LEGACY" || e.type === "LATE_READY") continue;
      opening = e;
      break;
    }
  }
  const ageMs = opening.ts ? Date.now() - Date.parse(opening.ts) : null;
  const stale = ageMs === null || ageMs >= WINDOW_TTL_MS;
  return {
    open: !stale, // stale = treated as closed (zombie)
    ready,
    ownerSessionId: opening.sessionId || null,
    startedAt: opening.ts,
    ageMs,
    resumable: false,
  };
}

// ---------- helpers ----------

/** Current session id — single source for BOTH /renew and agent-renew-ready:
 * sessionManager.getSessionId() (the session file name embeds the same UUID;
 * never re-derive from the file name — two schemes drifting apart would break
 * every owner comparison, 2026-10-27 challenge-audit HIGH-2). */
function currentSessionId(ctx: ExtensionCommandContext): string {
  return ctx.sessionManager.getSessionId?.() ?? "unknown";
}

/** Walk up from cwd to ~ looking for .agents/agents/. Returns nearest hit or null. */
function findAgentsRoot(cwd: string): string | null {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".agents", "agents");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

interface OnDuty {
  agentName: string;
  agentDir: string;
  entryIndex: number;
  startedAt: string;
}

/** Find the agent whose sessions.log has an open (endedAt:null) entry for
 *  sessionId. Dangling null entries from dead predecessors are tolerated:
 *  ANY null entry matching counts (2026-10-27 challenge-audit MEDIUM-7 —
 *  lead carried 3 dangling nulls; last-entry-only matching locked renewal). */
function matchIdentity(agentsRoot: string, sessionId: string): OnDuty | null {
  let names: string[];
  try {
    names = readdirSync(agentsRoot).filter((n) => {
      try {
        return statSync(join(agentsRoot, n)).isDirectory();
      } catch {
        return false; // broken symlink / raced deletion — skip, don't fail the scan
      }
    });
  } catch {
    return null;
  }
  for (const name of names) {
    const logPath = join(agentsRoot, name, "sessions.log");
    if (!existsSync(logPath)) continue;
    const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue; // malformed line — skip
      }
      if (entry.endedAt !== null && entry.endedAt !== undefined) continue;
      if (entry.sessionId === sessionId) {
        return {
          agentName: name,
          agentDir: join(agentsRoot, name),
          entryIndex: i,
          startedAt: String(entry.startedAt ?? ""),
        };
      }
      // dangling null owned by a dead session — keep scanning (don't break)
    }
  }
  return null;
}

/**
 * Append-only style update of the old row's endedAt (edit only that field in
 * place — SPEC §6: 补全字段不算改历史；note 内容不动). Verifies the target row's
 * sessionId BEFORE editing (audit HIGH-3: a stale entryIndex after concurrent
 * log modification would corrupt a sibling row).
 */
function closeOnDutyEntry(
  agentDir: string,
  onDuty: OnDuty,
  expectedSessionId: string,
  endedAt: string
): void {
  const logPath = join(agentDir, "sessions.log");
  const lines = readFileSync(logPath, "utf8").split("\n");
  if (onDuty.entryIndex >= lines.length) {
    throw new Error(`sessions.log 行 ${onDuty.entryIndex} 不存在（日志被并发修改）`);
  }
  const entry = JSON.parse(lines[onDuty.entryIndex]);
  if (entry.sessionId !== expectedSessionId) {
    throw new Error(
      `sessions.log 行 ${onDuty.entryIndex} 的 sessionId (${String(entry.sessionId).slice(0, 8)}) 与当值者 (${expectedSessionId.slice(0, 8)}) 不符——日志被并发修改，拒绝盲改`
    );
  }
  entry.endedAt = endedAt;
  lines[onDuty.entryIndex] = JSON.stringify(entry);
  writeFileSync(logPath, lines.join("\n"));
}

function appendSessionEntry(
  agentDir: string,
  sessionId: string,
  note: string,
  handoffFile: string
): void {
  // Pure append (appendFileSync) — a read-all + rewrite would race concurrent
  // appends and truncate the log on a mid-write crash (audit MEDIUM-4).
  const entry = {
    sessionId,
    startedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    endedAt: null,
    note,
    handoffFile,
  };
  const body = readFileSyncSafe(join(agentDir, "sessions.log"));
  const prefix = body.length > 0 && !body.endsWith("\n") ? "\n" : "";
  appendFileSync(join(agentDir, "sessions.log"), prefix + JSON.stringify(entry) + "\n");
}

/** Extract SPEC §7 当值纪律 section (from the numbered list to the next ## or EOF). */
function extractSpecDiscipline(specPath: string): string {
  if (!existsSync(specPath)) return "（SPEC.md 不在，纪律见 ~/.agents/agents/SPEC.md §7）";
  const text = readFileSync(specPath, "utf8");
  const m = text.match(/## 7\.[\s\S]*?(?=\n## \d|\n## [^\d]|$)/);
  return m ? m[0].trim() : "（SPEC.md §7 未找到，请直接读 ~/.agents/agents/SPEC.md）";
}

/** Read the 交接附言 section from STATE.md (last ## section). */
function extractHandoffNote(statePath: string): string | null {
  if (!existsSync(statePath)) return null;
  const text = readFileSync(statePath, "utf8");
  const m = text.match(/##\s*交接附言\s*\n([\s\S]*?)(?=\n## |$)/);
  const body = m?.[1]?.trim();
  return body && body.length > 0 && !body.startsWith("（") ? body : null;
}

// ---------- prompt assembly (SPEC §6: 只放指针不复制内容) ----------

function buildInitialPrompt(
  agentDir: string,
  agentName: string,
  handoffNote: string
): string {
  // AGENT.json missing/corrupt must not throw from the command handler — that
  // would leave the START event as a zombie window until TTL (audit MEDIUM-6).
  let manifest: { workspace?: string; name?: string };
  try {
    manifest = JSON.parse(readFileSync(join(agentDir, "AGENT.json"), "utf8"));
  } catch (err) {
    throw new Error(`AGENT.json 读取失败（${agentDir}）：${err instanceof Error ? err.message : err}`);
  }
  // SPEC 唯一真相源在全局 workspace：~/.agents/agents/SPEC.md；工作区副本（若有）优先
  const workspaceSpec = join(agentDir, "..", "SPEC.md");
  const globalSpec = join(process.env.HOME ?? "", ".agents", "agents", "SPEC.md");
  const specPath = existsSync(workspaceSpec) ? workspaceSpec : globalSpec;
  const discipline = extractSpecDiscipline(specPath);

  return [
    `你现在就是 ${agentName}（${manifest.workspace} 的具名 agent，刚完成换届上岗）。`,
    "",
    "## 身份（按序读文件，本 prompt 只放指针不复制内容）",
    `- 身份卡: ${agentDir}/AGENT.json（name=${manifest.name}；resources 是换届记忆提醒非权限边界）`,
    `- 使命/职责/红线: ${agentDir}/charter.md（上岗必读）`,
    `- 协作拓扑: ${agentDir}/peers.md（需要协作时读）`,
    "",
    "## 当值纪律（SPEC.md §7 原文）",
    discipline,
    "",
    "## 状态",
    `- 战役快照与 Backlog: ${agentDir}/STATE.md（你就是它的当值维护者，保持新鲜）`,
    `- Backlog 第一条是下一步第一动作。`,
    "",
    "## 交接附言（上一届原话）",
    handoffNote,
    "",
    "上岗 checklist：",
    "1. 读上面四个文件确认现状（SESSION id 用 agent-session-id 工具取，sessions.log 上岗登记按 SPEC §7 纪律 5 追加，同时废弃前任悬空的 null 条目）；",
    "2. 核对前任名下的 daemon 订阅归属：订阅随 session 生死，将死 session 名下的订阅 cancel 后重挂到本 session（pi-events-daemon 继承功能在联合开发中，见其仓 ticket）；",
    "3. 按 STATE「活跃后台资产」节的可寻回标识找回脱离 session 的任务（远端节点脚本、-d 容器等）；",
    "4. 全部确认后从 STATE.md Backlog 第一条继续推进。",
  ].join("\n");
}

// ---------- extension ----------

export default function renewExtension(pi: ExtensionAPI) {
  // run-start latch (waitForIdle resolves immediately if no run has started yet —
  // 2026-10-21 regen-gov incident). Per-command via event + closure, not module state.
  // Declare before the pi.on registration; /renew concurrency is already blocked
  // by the window mutex before any latch reset, so a single latch pair is safe.
  let runStartedFlag = false;
  let armAgentStart = false;

  pi.on("agent_start", async () => {
    if (armAgentStart) runStartedFlag = true;
  });

  pi.registerTool({
    name: "agent-session-id",
    label: "Agent Session Id",
    description:
      "返回当前 pi session 的 UUID（sessions.log 登记必须用这个值，禁止手写或凭记忆——历届事故均源于手抄错 id）。无副作用。",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, toolCtx) {
      const sid = toolCtx?.sessionManager?.getSessionId?.() ?? "unknown";
      return {
        content: [{ type: "text", text: sid }],
        details: { sessionId: sid },
      };
    },
  });

  pi.registerTool({
    name: "agent-renew-ready",
    label: "Agent Renew Ready",
    description:
      "换届流程专用：当 /renew 指令要求你完成换届 checklist 后，用模型原生工具调用（直接 toolCall，不要经 bash/codemode 转发）调用本工具确认就绪。窗口外调用会记录 late-ready 并返回错误。",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, toolCtx) {
      // The tool's own session — the window owner check uses it. Same source as
      // the /renew handler (sessionManager.getSessionId()) so owner comparison
      // can never split across two derivation schemes.
      const callerSessionId = toolCtx?.sessionManager?.getSessionId?.() ?? "unknown";
      const agentsRoot = toolCtx?.cwd ? findAgentsRoot(toolCtx.cwd) : null;
      if (!agentsRoot) {
        return {
          content: [{ type: "text", text: "错误：不在任何 agent workspace 内（找不到 .agents/agents/）。" }],
          details: { ok: false },
        };
      }
      const onDuty = matchIdentity(agentsRoot, callerSessionId);
      if (!onDuty) {
        return {
          content: [{ type: "text", text: `错误：本 session (${callerSessionId.slice(0, 8)}) 不是任何 agent 的当值者，无法确认换届就绪。` }],
          details: { ok: false },
        };
      }
      const win = readWindowState(onDuty.agentDir);
      if (!win.open || win.ownerSessionId !== callerSessionId) {
        // LATE_READY: an out-of-window call, recorded for audit ONLY. It must
        // NOT participate in window derivation (readWindowState treats tail
        // READY as an open ready window) — writing READY here would forge a
        // ready window and skip validation on the next /renew (2026-10-27
        // challenge-audit HIGH-1).
        appendRenewEvent(onDuty.agentDir, {
          type: "LATE_READY",
          sessionId: callerSessionId,
          detail: "rejected: no open window owned by this session (out-of-window call recorded for late-ready audit)",
        });
        return {
          content: [
            {
              type: "text",
              text: "错误：当前没有属于本 session 的进行中换届窗口（/renew 未触发、已中止或属主不是本 session）。该调用已记录；若你已完成 STATE 更新，用户重新执行 /renew 时会检测到并直接续办。",
            },
          ],
          details: { ok: false },
        };
      }
      appendRenewEvent(onDuty.agentDir, { type: "READY", sessionId: callerSessionId });
      return {
        content: [{ type: "text", text: "已确认就绪，换届流程继续。" }],
        details: { ok: true },
      };
    },
  });

  pi.registerCommand("renew", {
    description: "Agent 换届：更新 STATE → 原地新 session → 自动发送身份 prompt（SPEC.md §6）",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        ctx.ui.notify("/renew 需要交互模式", "error");
        return;
      }

      // 1. identity match
      const sessionId = currentSessionId(ctx);
      const agentsRoot = findAgentsRoot(ctx.cwd);
      if (!agentsRoot) {
        ctx.ui.notify("未找到 .agents/agents/（从 cwd 向上到 ~）。本目录不是 agent workspace。", "error");
        return;
      }
      const onDuty = matchIdentity(agentsRoot, sessionId);
      if (!onDuty) {
        ctx.ui.notify(
          `本 session (${sessionId.slice(0, 8)}) 不是任何 agent 的当值者（sessions.log 指纹不匹配）。先 agent-bootstrap 登记（用 agent-session-id 工具取 id）。`,
          "error"
        );
        return;
      }

      // 2. window acquisition (ownership triple + TTL), state in renew.log
      const win = readWindowState(onDuty.agentDir);
      let resumed = false;
      if (win.open) {
        if (win.ownerSessionId === sessionId) {
          // same owner: READY already appended → resume; otherwise true concurrent re-entry → refuse
          if (win.ready) {
            resumed = true;
            ctx.ui.notify("换届续办：检测到本窗口内 agent 已确认就绪，跳过指令直接校验。", "info");
          } else {
            ctx.ui.notify(
              `换届拒绝：本 session 已有一个进行中的换届窗口（${Math.round((win.ageMs ?? 0) / 1000)}s 前开启）。等 agent 完成 checklist 后窗口会自动推进；若确认卡死，${Math.round(WINDOW_TTL_MS / 60000)} 分钟后可重新触发接管。`,
              "error"
            );
            return;
          }
        } else {
          // different owner: dead predecessor's window → takeover
          appendRenewEvent(onDuty.agentDir, {
            type: "TAKEOVER",
            sessionId,
            detail: `took over stale window owned by ${win.ownerSessionId?.slice(0, 8)}`,
          });
          ctx.ui.notify(`换届接管：清除前任 session 的残留窗口（${win.ownerSessionId?.slice(0, 8)}）。`, "info");
        }
      } else if (win.resumable) {
        // READY was confirmed but the handler aborted (e.g. placeholder note);
        // if the note is fixed now, resume straight to validation.
        const note = extractHandoffNote(join(onDuty.agentDir, "STATE.md"));
        if (note) {
          resumed = true;
          ctx.ui.notify("换届续办：上一窗口已确认就绪但校验中止，检测到附言已写实，直接进入校验。", "info");
        }
      }
      if (!win.open && !resumed) {
        appendRenewEvent(onDuty.agentDir, { type: "START", sessionId });
      }

      const statePath = join(onDuty.agentDir, "STATE.md");

      if (!resumed) {
        // 3. instruct the agent to run the checklist
        runStartedFlag = false;
        armAgentStart = true;
        ctx.ui.notify(`换届开始：${onDuty.agentName} @ ${onDuty.agentDir}`, "info");
        pi.sendUserMessage(
          [
            "换届流程启动（/renew）。请按以下 checklist 逐项执行：",
            "1. 后台资产分类处置（SPEC §7 纪律 6）：",
            "   a. 绑定本 session 进程的（subagent、非 detached bg 任务）：等完成/收尾后再继续换届；确实等不了的先终止或写明交接处理方式；",
            "   b. 脱离 session 进程的（daemon 订阅、远端节点脚本、-d 容器等）：在 STATE.md「活跃后台任务」节记录可寻回标识（订阅 id/容器/节点名/任务 id），换届后新 session 按标识找回；",
            "   c. daemon 订阅专项：把需要在换届后继续生效的订阅 cancel 掉，由新 session 重新挂（daemon 订阅随 session 生死，无法继承——继承功能在联合开发中，见其仓 ticket）；",
            "2. 更新 STATE.md：刷新战役快照与活跃后台资产（含标识）、重排 Backlog、交接附言写实（本届做了什么/未完成什么/下一届第一动作），并附上隐性操作知识指针（哪些经验/教训/直觉判断沉淀在哪个文档，让下一届不用重新探索）——按 SPEC §7 纪律 4/7；",
            "3. 全部完成后，用模型原生工具调用（直接 toolCall，不要经 bash/codemode 转发）调用 agent-renew-ready 确认。不要做其他事。",
          ].join("\n")
        );

        // 4. wait for the instruction turn to actually start, then for it to finish.
        for (let i = 0; i < 100 && !runStartedFlag; i++) {
          await new Promise((r) => setTimeout(r, 100)); // up to 10s for run start
        }
        armAgentStart = false;
        if (!runStartedFlag) {
          appendRenewEvent(onDuty.agentDir, {
            type: "ABORT",
            sessionId,
            detail: "instruction turn never started within 10s",
          });
          ctx.ui.notify("换届中止：指令发出后 10s 内 agent turn 未启动（session 可能无模型或卡死）。", "error");
          return;
        }
        await ctx.waitForIdle();
      } else {
        runStartedFlag = false;
      }

      // 5. validate: non-resumed windows must have their own READY in the tail;
      // resumed windows already carry READY from the prior segment.
      const winCheck = resumed ? { ready: true } : readWindowState(onDuty.agentDir);
      const handoffNote = extractHandoffNote(statePath);
      if (!winCheck.ready || !handoffNote) {
        appendRenewEvent(onDuty.agentDir, {
          type: "ABORT",
          sessionId,
          detail: !winCheck.ready
            ? "agent did not confirm agent-renew-ready within the window (renew.log tail not READY)"
            : "STATE.md 交接附言 empty or placeholder",
        });
        const why = !winCheck.ready
          ? "agent 未（在本窗口内）确认 agent-renew-ready；若它实际已完成 STATE 更新，重新执行 /renew 会自动续办"
          : "STATE.md 的「交接附言」为空或仍是占位文本";
        ctx.ui.notify(`换届中止：${why}。处理后重新执行 /renew。`, "error");
        return;
      }

      // 6. build prompt + audit file — guard so a corrupt AGENT.json aborts the
      // window cleanly (ABORT event) instead of leaving a zombie until TTL.
      let prompt: string;
      try {
        prompt = buildInitialPrompt(onDuty.agentDir, onDuty.agentName, handoffNote);
      } catch (err) {
        appendRenewEvent(onDuty.agentDir, {
          type: "ABORT",
          sessionId,
          detail: `prompt build failed: ${err instanceof Error ? err.message : err}`,
        });
        ctx.ui.notify(`换届中止：${err instanceof Error ? err.message : err}。`, "error");
        return;
      }
      const handoffsDir = join(onDuty.agentDir, "handoffs");
      if (!existsSync(handoffsDir)) mkdirSync(handoffsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const handoffFile = join(handoffsDir, `${ts}-from-${sessionId.slice(0, 8)}.md`);
      writeFileSync(handoffFile, prompt);

      // 7. in-place session replacement + bookkeeping + auto-send.
      // Bookkeeping is failure-guarded: a half-done registration is worse than a
      // logged failure (new session exists but sessions.log unrenewed) — every
      // step verifies its precondition and any error lands in renew.log so the
      // next /renew can see what happened (audit HIGH-3).
      const oldSessionId = sessionId;
      const agentDir = onDuty.agentDir;
      const endedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      const result = await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        withSession: async (replacementCtx) => {
          const newId = currentSessionId(replacementCtx as ExtensionCommandContext);
          try {
            closeOnDutyEntry(agentDir, onDuty, oldSessionId, endedAt);
            appendSessionEntry(
              agentDir,
              newId,
              `换届自 ${oldSessionId.slice(0, 8)}（/renew 自动登记）`,
              handoffFile
            );
          } catch (err) {
            // Registration failure with the new session already created: log it
            // loudly and still deliver the prompt — the agent identity works,
            // only the ledger is stale; next /renew/--adopt can repair.
            appendRenewEvent(agentDir, {
              type: "ABORT",
              sessionId: oldSessionId,
              detail: `sessions.log bookkeeping failed after newSession: ${err instanceof Error ? err.message : err} — LEDGER STALE, repair manually`,
            });
          }
          // DONE only after the prompt actually reaches the new session
          // (audit: DONE-before-send claimed success on a half-delivered handover).
          await replacementCtx.sendUserMessage(prompt);
          appendRenewEvent(agentDir, {
            type: "DONE",
            sessionId: oldSessionId,
            newSessionId: newId,
            handoffFile,
          });
        },
      });

      if (result.cancelled) {
        // newSession cancelled — bookkeeping (inside withSession) never ran, so the
        // window is still open per renew.log; close it explicitly with ABORT.
        appendRenewEvent(agentDir, { type: "CANCELLED", sessionId: oldSessionId, detail: "newSession cancelled by user" });
        ctx.ui.notify("换届取消（新 session 未创建）", "info");
      }
    },
  });
}
