// Decision-table tests for pi-timekeeper's pure decision functions (ticket #47).
// TZ-independence strategy: shape assertions for anchorLine, fixed epoch ms +
// relative localDate(now) expectations for decision rows — never assert
// host-timezone-specific concrete values.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  anchorLine,
  computeInjection,
  configFromEnv,
  localDate,
  restoreState,
  type TKConfig,
  type TKState,
} from "../state.ts";

const HOUR = 3600_000;
const NOW = 1_758_612_000_000; // arbitrary fixed epoch ms

const today = () => localDate(NOW);

describe("DEFAULT_CONFIG", () => {
  it("matches the spec defaults (reminder on, 1h interval)", () => {
    expect(DEFAULT_CONFIG).toEqual({ reminderEnabled: true, reminderIntervalSeconds: 3600 });
  });
});

describe("localDate", () => {
  it("renders ISO order (sv-SE)", () => {
    expect(localDate(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is stable for the same instant", () => {
    expect(localDate(NOW)).toBe(localDate(NOW));
  });
});

describe("anchorLine", () => {
  const line = anchorLine(NOW);

  it("has the exact sentence shape: tag + date (weekday) time, tz.", () => {
    // TZ-independent: assert the shape, not concrete values.
    expect(line).toMatch(/^<time_anchor>It is \d{4}-\d{2}-\d{2} \([A-Za-z]+\) \d{2}:\d{2}:\d{2}, \S+\.<\/time_anchor>$/);
  });

  it("starts with the local calendar date", () => {
    expect(line.startsWith(`<time_anchor>It is ${localDate(NOW)} (`)).toBe(true);
  });
});

describe("computeInjection — decision table", () => {
  const enabled: TKConfig = { reminderEnabled: true, reminderIntervalSeconds: 3600 };
  const disabled: TKConfig = { reminderEnabled: false, reminderIntervalSeconds: 3600 };

  it("0. content is wrapped in a <time_anchor> tag (B1: compensates the lost developer channel)", () => {
    const r = computeInjection({}, NOW, enabled);
    expect(r.content).toMatch(/^<time_anchor>It is .*<\/time_anchor>$/);
  });
  it("1. first run anchors (empty state)", () => {
    const r = computeInjection({}, NOW, enabled);
    expect(r.injected).toBe(true);
    expect(r.content).toMatch(/^<time_anchor>It is /);
    expect(r.state).toEqual({ lastDate: today(), lastReminderAt: NOW });
  });

  it("2. same window: no injection", () => {
    const s: TKState = { lastDate: today(), lastReminderAt: NOW };
    expect(computeInjection(s, NOW + 60_000, enabled).injected).toBe(false);
  });

  it("3. interval elapsed: injects and refreshes lastReminderAt", () => {
    const s: TKState = { lastDate: today(), lastReminderAt: NOW - HOUR - 60_000 };
    const r = computeInjection(s, NOW, enabled);
    expect(r.injected).toBe(true);
    expect(r.state.lastReminderAt).toBe(NOW);
  });

  it("4. boundary: exactly interval elapsed injects (>=)", () => {
    const s: TKState = { lastDate: today(), lastReminderAt: NOW - HOUR };
    expect(computeInjection(s, NOW, enabled).injected).toBe(true);
  });

  it("5. just under interval: no injection", () => {
    const s: TKState = { lastDate: today(), lastReminderAt: NOW - HOUR + 1 };
    expect(computeInjection(s, NOW, enabled).injected).toBe(false);
  });

  it("6. date change injects but does NOT refresh lastReminderAt", () => {
    const oldReminder = NOW - 60_000; // interval NOT elapsed
    const s: TKState = { lastDate: "1999-12-31", lastReminderAt: oldReminder };
    const r = computeInjection(s, NOW, enabled);
    expect(r.injected).toBe(true);
    expect(r.state.lastDate).toBe(today());
    expect(r.state.lastReminderAt).toBe(oldReminder);
  });

  it("7. force with reminder enabled refreshes both fields", () => {
    const s: TKState = { lastDate: today(), lastReminderAt: NOW };
    const r = computeInjection(s, NOW, enabled, { force: true });
    expect(r.injected).toBe(true);
    expect(r.state).toEqual({ lastDate: today(), lastReminderAt: NOW });
  });

  it("8. force with reminder disabled refreshes lastDate only (adjudicated: prototype semantics)", () => {
    const t0 = NOW - 5 * HOUR;
    const s: TKState = { lastDate: today(), lastReminderAt: t0 };
    const r = computeInjection(s, NOW, disabled, { force: true });
    expect(r.injected).toBe(true);
    expect(r.state.lastDate).toBe(today());
    expect(r.state.lastReminderAt).toBe(t0);
  });

  it("9. reminder disabled, no date change, no force: nothing due", () => {
    const s: TKState = { lastDate: today(), lastReminderAt: NOW - 5 * HOUR };
    expect(computeInjection(s, NOW, disabled).injected).toBe(false);
  });

  it("10. no-catch-up: many missed intervals collapse into one injection", () => {
    const s: TKState = { lastDate: today(), lastReminderAt: NOW - 5 * HOUR };
    const r = computeInjection(s, NOW, enabled);
    expect(r.injected).toBe(true);
    expect(r.state.lastReminderAt).toBe(NOW);
    expect(typeof r.content).toBe("string");
  });

  it("11. forcePending in state forces injection even when nothing else is due (B2)", () => {
    const s: TKState = { lastDate: today(), lastReminderAt: NOW, forcePending: true };
    const r = computeInjection(s, NOW, enabled);
    expect(r.injected).toBe(true);
    // persisted pending-reanchor flag is consumed by the injection
    expect(r.state).toEqual({ lastDate: today(), lastReminderAt: NOW });
    expect(r.state.forcePending).toBeUndefined();
  });

  it("12. forcePending survives reminder-disabled (compaction re-anchor must not depend on reminder)", () => {
    const s: TKState = { lastDate: today(), lastReminderAt: NOW, forcePending: true };
    const r = computeInjection(s, NOW, disabled);
    expect(r.injected).toBe(true);
    expect(r.state.forcePending).toBeUndefined();
  });

  it("13. forcePending absent: same-window state stays silent (no regression)", () => {
    const s: TKState = { lastDate: today(), lastReminderAt: NOW };
    expect(computeInjection(s, NOW, enabled).injected).toBe(false);
  });
});

describe("configFromEnv", () => {
  it("defaults when nothing is set", () => {
    expect(configFromEnv({})).toEqual(DEFAULT_CONFIG);
  });

  it.each(["false", "0"])("disables reminder on %s", (v) => {
    expect(configFromEnv({ TIMEKEEPER_REMINDER_ENABLED: v }).reminderEnabled).toBe(false);
  });

  it.each(["1", "true", "yes"])("keeps reminder enabled on %s", (v) => {
    expect(configFromEnv({ TIMEKEEPER_REMINDER_ENABLED: v }).reminderEnabled).toBe(true);
  });

  it("applies a valid positive interval", () => {
    expect(configFromEnv({ TIMEKEEPER_INTERVAL_SECONDS: "1800" }).reminderIntervalSeconds).toBe(1800);
  });

  it.each(["abc", "0", "-5", ""])("falls back to default interval on %s", (v) => {
    expect(configFromEnv({ TIMEKEEPER_INTERVAL_SECONDS: v }).reminderIntervalSeconds).toBe(3600);
  });

  it("does not read process.env when an env object is passed", () => {
    const saved = process.env.TIMEKEEPER_REMINDER_ENABLED;
    process.env.TIMEKEEPER_REMINDER_ENABLED = "false";
    try {
      expect(configFromEnv({}).reminderEnabled).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.TIMEKEEPER_REMINDER_ENABLED;
      else process.env.TIMEKEEPER_REMINDER_ENABLED = saved;
    }
  });
});

describe("restoreState", () => {
  const entry = (customType: string | undefined, data: unknown) => ({ customType, data });

  it("returns empty state for no entries", () => {
    expect(restoreState([])).toEqual({});
  });

  it("ignores non-timekeeper entries and undefined holes", () => {
    const entries = [undefined, entry("other", { lastDate: "2000-01-01" }), entry(undefined, {})] as Parameters<
      typeof restoreState
    >[0];
    expect(restoreState(entries)).toEqual({});
  });

  it("latest timekeeper.state wins", () => {
    const entries = [
      entry("timekeeper.state", { lastDate: "2000-01-01", lastReminderAt: 1 }),
      entry("timekeeper.state", { lastDate: "2001-02-03", lastReminderAt: 2, forcePending: true }),
    ];
    expect(restoreState(entries)).toEqual({
      lastDate: "2001-02-03",
      lastReminderAt: 2,
      forcePending: true,
    });
  });

  it("forcePending non-boolean normalizes to undefined", () => {
    const entries = [entry("timekeeper.state", { lastDate: "2001-02-03", lastReminderAt: 2, forcePending: "yes" })];
    expect(restoreState(entries)).toEqual({ lastDate: "2001-02-03", lastReminderAt: 2, forcePending: undefined });
  });

  it("field-corrupt latest: normalizes to undefined, no rescan to earlier entries", () => {
    const entries = [
      entry("timekeeper.state", { lastDate: "2000-01-01", lastReminderAt: 1 }),
      entry("timekeeper.state", { lastDate: 123, lastReminderAt: "oops" }),
    ];
    expect(restoreState(entries)).toEqual({ lastDate: undefined, lastReminderAt: undefined });
  });

  it.each([null, undefined, "junk", 42])("entry-level data %p: skips and rescans earlier entries", (bad) => {
    const entries = [
      entry("timekeeper.state", { lastDate: "2000-01-01", lastReminderAt: 1 }),
      entry("timekeeper.state", bad),
    ];
    expect(restoreState(entries)).toEqual({ lastDate: "2000-01-01", lastReminderAt: 1 });
  });

  it("data: {} passes the guard — scan terminates, fields normalize, NO rescan (prototype semantics)", () => {
    const entries = [
      entry("timekeeper.state", { lastDate: "2000-01-01", lastReminderAt: 1 }),
      entry("timekeeper.state", {}),
    ];
    expect(restoreState(entries)).toEqual({ lastDate: undefined, lastReminderAt: undefined });
  });

  it("roundtrip: computeInjection result state survives the entry shape", () => {
    const r = computeInjection({}, NOW, DEFAULT_CONFIG);
    expect(r.injected).toBe(true);
    const persisted = entry("timekeeper.state", r.state);
    expect(restoreState([persisted])).toEqual(r.state);
  });

  it("roundtrip: forcePending survives persistence and is consumed by the next computeInjection", () => {
    const persisted = entry("timekeeper.state", { lastDate: localDate(NOW), lastReminderAt: NOW, forcePending: true });
    const restored = restoreState([persisted]);
    const r = computeInjection(restored, NOW, DEFAULT_CONFIG);
    expect(r.injected).toBe(true);
    expect(r.state.forcePending).toBeUndefined();
  });
});
