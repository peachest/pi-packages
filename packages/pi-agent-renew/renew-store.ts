/**
 * renew-store — the handover ledger (换届账本): the renew.log event stream plus
 * the sessions.log on-duty register. Moved verbatim from renew.ts (move-only).
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
  ts: string; // ISO
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
export function parseRenewLog(agentDir: string): RenewEvent[] {
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

/** Derive the current window state from the tail of renew.log. */
export function readWindowState(agentDir: string): WindowState {
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
  const body = readFileSyncSafe(join(agentDir, "sessions.log"));
  const prefix = body.length > 0 && !body.endsWith("\n") ? "\n" : "";
  appendFileSync(join(agentDir, "sessions.log"), prefix + JSON.stringify(entry) + "\n");
}
