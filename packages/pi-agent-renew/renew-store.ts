/**
 * renew-store — the handover ledger (换届账本): the renew.log event stream plus
 * the sessions.log on-duty register. Moved from renew.ts: ticket #181 verbatim;
 * #182 split deriveWindowState(events, now) out of readWindowState; rolling
 * review r1 hardening (#1 index base, #4 sessionId check, #5/#6 read+parse
 * guards, #7 appendLineSafe).
 *
 * No dependency injection, by design: production and tests both run against the
 * real filesystem — there is no second adapter. This seam exists for locality
 * (the ledger protocol knowledge lives in exactly one file) and test surface,
 * NOT for replaceability; do not add DI here.
 *
 * LEGACY lines are the v0.2 free-text compatibility form and never participate
 * in state derivation (GLOSSARY.md — 换届账本).
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export const WINDOW_TTL_MS = 30 * 60 * 1000; // same-owner re-entry freshness (user-approved)

// ---------- renew.log event stream (the window state machine) ----------

export interface RenewEvent {
  type: "START" | "READY" | "LATE_READY" | "TAKEOVER" | "DONE" | "ABORT" | "CANCELLED" | "LEGACY";
  ts: string; // ISO（LEGACY 占位事件为空串，Date.parse 会得 NaN——LEGACY 永不参与推导）
  sessionId: string; // owner of the window / actor of the event
  detail?: string;
  newSessionId?: string;
  handoffFile?: string;
}

export function renewLogPath(agentDir: string): string {
  return join(agentDir, "renew.log");
}

export function appendRenewEvent(agentDir: string, ev: Omit<RenewEvent, "ts">): void {
  const full: RenewEvent = { ...ev, ts: new Date().toISOString() };
  appendLineSafe(renewLogPath(agentDir), JSON.stringify(full));
}

function readFileSyncSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** Append one JSONL line, repairing a missing trailing newline first (r1 #7:
 *  the read-body -> newline-guard -> append pattern shared by both appenders). */
function appendLineSafe(path: string, text: string): void {
  const body = readFileSyncSafe(path);
  const prefix = body.length > 0 && !body.endsWith("\n") ? "\n" : "";
  appendFileSync(path, prefix + text + "\n");
}

/** Parse renew.log tolerantly: JSON lines with {type,...}; legacy free-text lines become LEGACY. */
export function parseRenewLog(agentDir: string): RenewEvent[] {
  const lines = readFileSyncSafe(renewLogPath(agentDir)).split("\n").filter((l) => l.trim());
  const events: RenewEvent[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      // 合法行判定：type/ts 之外 sessionId 也必须非空 string（r1 #4）——
      // 缺失时模板串会输出 "undefined" 混入推导
      if (typeof e.type === "string" && typeof e.ts === "string" && typeof e.sessionId === "string" && e.sessionId !== "") {
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

export const TERMINAL_TYPES = new Set(["DONE", "ABORT", "CANCELLED"]);

export interface WindowState {
  open: boolean;
  ready: boolean;
  ownerSessionId: string | null;
  startedAt: string | null;
  ageMs: number | null;
  /** last window segment (START..ABORT) reached READY — a later /renew with
   *  non-placeholder handoff note can resume instead of re-instructing. */
  resumable: boolean;
}

/** Derive the current window state from the tail of the renew event stream.
 *  Pure: no IO, no Date.now() — `now` is the ms timestamp (same semantics as
 *  the former inline `Date.now() - Date.parse(opening.ts)`). */
export function deriveWindowState(events: RenewEvent[], now: number): WindowState {
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
  const ageMs = opening.ts ? now - Date.parse(opening.ts) : null;
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

/** Thin IO shell: parse renew.log, then derive with the wall clock. */
export function readWindowState(agentDir: string): WindowState {
  return deriveWindowState(parseRenewLog(agentDir), Date.now());
}

export interface OnDuty {
  agentName: string;
  agentDir: string;
  entryIndex: number;
  startedAt: string;
}

/**
 * Append-only style update of the old row's endedAt (edit only that field in
 * place — SPEC §6: 补全字段不算改历史；note 内容不动). Verifies the target row's
 * sessionId BEFORE editing (audit HIGH-3: a stale entryIndex after concurrent
 * log modification would corrupt a sibling row).
 */
export function closeOnDutyEntry(
  agentDir: string,
  onDuty: OnDuty,
  expectedSessionId: string,
  endedAt: string
): void {
  const logPath = join(agentDir, "sessions.log");
  // matchIdentity 的 entryIndex 基于空行过滤后的数组（r1 #1）——这里必须用同一基准，
  // 否则 sessions.log 含空行（appendRenewEvent 竞态的无害产物）即错位
  const body = readFileSyncSafe(logPath);
  if (!body.trim()) {
    throw new Error(`sessions.log 为空或不存在（${logPath}）`);
  }
  const lines = body.split("\n").filter((l) => l.trim());
  if (onDuty.entryIndex < 0) {
    throw new Error(`sessions.log entryIndex 非法（${onDuty.entryIndex}）`);
  }
  if (onDuty.entryIndex >= lines.length) {
    throw new Error(`sessions.log 行 ${onDuty.entryIndex} 不存在（日志被并发修改）`);
  }
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(lines[onDuty.entryIndex]);
  } catch (err) {
    throw new Error(`sessions.log 行 ${onDuty.entryIndex} JSON 解析失败：${lines[onDuty.entryIndex].slice(0, 20)}（${err instanceof Error ? err.message : String(err)}）`);
  }
  if (entry.sessionId !== expectedSessionId) {
    throw new Error(
      `sessions.log 行 ${onDuty.entryIndex} 的 sessionId (${String(entry.sessionId).slice(0, 8)}) 与当值者 (${expectedSessionId.slice(0, 8)}) 不符——日志被并发修改，拒绝盲改`
    );
  }
  entry.endedAt = endedAt;
  lines[onDuty.entryIndex] = JSON.stringify(entry);
  writeFileSync(logPath, lines.join("\n"));
}

export function appendSessionEntry(
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
  appendLineSafe(join(agentDir, "sessions.log"), JSON.stringify(entry));
}
