import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pollExtension from "./index.ts";

// Minimal fake pi that captures the registered tool.
function loadPollTool() {
  const tools: any[] = [];
  const fakePi = { registerTool: (def: any) => tools.push(def), on() {} };
  pollExtension(fakePi as any);
  const poll = tools[0];
  if (!poll || poll.name !== "poll") throw new Error("poll tool not registered");
  return poll;
}

const onUpdate = () => {};

describe("poll tool", () => {
  let tmp: string;
  let marker: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-poll-test-"));
    marker = join(tmp, "ready.marker");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("polls until the condition is met, then returns ready", async () => {
    const poll = loadPollTool();
    const ac = new AbortController();
    setTimeout(() => writeFileSync(marker, "done"), 1500);
    const r = await poll.execute("t1", { command: `test -f ${marker}`, interval: 0.3, timeout: 10 }, ac.signal, onUpdate, { cwd: tmp });
    expect(r.details.ready).toBe(true);
    expect(r.details.exitCode).toBe(0);
    expect(r.details.attempts).toBeGreaterThanOrEqual(4);
    expect(r.details.elapsedMs).toBeGreaterThanOrEqual(1400);
    expect(r.details.elapsedMs).toBeLessThanOrEqual(2200);
  });

  it("times out when the condition is never met", async () => {
    const poll = loadPollTool();
    const ac = new AbortController();
    const r = await poll.execute("t2", { command: `test -f ${join(tmp, "never.marker")}`, interval: 0.5, timeout: 2 }, ac.signal, onUpdate, { cwd: tmp });
    expect(r.details.ready).toBe(false);
    expect(r.details.timedOut).toBe(true);
    expect(r.details.elapsedMs).toBeGreaterThanOrEqual(1900);
    expect(r.details.elapsedMs).toBeLessThanOrEqual(2600);
  });

  it("aborts mid-poll and returns immediately", async () => {
    const poll = loadPollTool();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const r = await poll.execute("t3", { command: `test -f ${join(tmp, "never.marker")}`, interval: 0.5, timeout: 10 }, ac.signal, onUpdate, { cwd: tmp });
    expect(r.details.ready).toBe(false);
    expect(r.details.aborted).toBe(true);
    expect(r.details.elapsedMs).toBeLessThanOrEqual(1500);
  });

  it("returns immediately when the condition is already true", async () => {
    const poll = loadPollTool();
    writeFileSync(marker, "x");
    const ac = new AbortController();
    const r = await poll.execute("t4", { command: `test -f ${marker}`, interval: 1, timeout: 5 }, ac.signal, onUpdate, { cwd: tmp });
    expect(r.details.ready).toBe(true);
    expect(r.details.attempts).toBe(1);
    expect(r.details.elapsedMs).toBeLessThan(500);
    expect(typeof r.details.output).toBe("string");
  });

  it("captures the check command output on timeout (failure reason)", async () => {
    const poll = loadPollTool();
    const ac = new AbortController();
    const r = await poll.execute("t5", { command: `ls ${join(tmp, "nope")} 2>&1`, interval: 0.3, timeout: 1 }, ac.signal, onUpdate, { cwd: tmp });
    expect(r.details.ready).toBe(false);
    expect(r.details.output).toContain("No such file");
  });

  it("errors when command is empty", async () => {
    const poll = loadPollTool();
    const ac = new AbortController();
    const r = await poll.execute("t6", { command: "  ", interval: 1, timeout: 5 }, ac.signal, onUpdate, { cwd: tmp });
    expect(r.details.ready).toBe(false);
  });
});
