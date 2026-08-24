import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";
const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";
const HERDR_BLOCKED_EVENT = "herdr:blocked";

interface BlockedEvent {
  active: boolean;
  label?: string;
}

// The module reads process.env.HERDR_ENV at load time. Set it before the
// static import so the bridge activates. (Static imports are hoisted, but
// setting the env here still runs before the module body because vitest
// evaluates this file's top-level statements in order before resolving
// hoisted imports — verified by the tests below passing.)
process.env.HERDR_ENV = "1";

// Use a fresh dynamic import so each test can control whether the bridge is
// loaded under HERDR_ENV=1 or not.
async function loadBridge() {
  const mod = await import("./index.ts");
  return mod.default;
}

function createFakePi() {
  const bus = new EventEmitter();
  const events = {
    on: (event: string, listener: (...args: unknown[]) => void) => bus.on(event, listener),
    emit: (event: string, ...args: unknown[]) => bus.emit(event, ...args),
  };
  return { bus, events };
}

function captureBlocked(bus: EventEmitter): BlockedEvent[] {
  const received: BlockedEvent[] = [];
  bus.on(HERDR_BLOCKED_EVENT, (data: BlockedEvent) => received.push({ ...data }));
  return received;
}

describe("pi-herdr-ask-bridge", () => {
  it("re-emits herdr:blocked active:true with a label when the questionnaire opens", async () => {
    const bridge = await loadBridge();
    const { bus, events } = createFakePi();
    bridge({ events } as any);

    const received = captureBlocked(bus);

    events.emit(ASK_USER_PROMPT_EVENT, {
      questions: [
        { question: "Which library should we use?", header: "Library", multiSelect: false, options: [] },
      ],
    });
    events.emit(ASK_USER_BLOCKED_EVENT, { active: true });

    expect(received).toHaveLength(1);
    expect(received[0].active).toBe(true);
    expect(received[0].label).toBe("❓ Library");
  });

  it("re-emits herdr:blocked active:false (no label) when the questionnaire closes", async () => {
    const bridge = await loadBridge();
    const { bus, events } = createFakePi();
    bridge({ events } as any);

    const received = captureBlocked(bus);

    events.emit(ASK_USER_PROMPT_EVENT, {
      questions: [{ question: "Auth method?", header: "Auth", multiSelect: false, options: [] }],
    });
    events.emit(ASK_USER_BLOCKED_EVENT, { active: true });
    events.emit(ASK_USER_BLOCKED_EVENT, { active: false });

    expect(received).toHaveLength(2);
    expect(received[0].active).toBe(true);
    expect(received[1].active).toBe(false);
    expect(received[1].label).toBeUndefined();
  });

  it("falls back to a truncated question when header is empty", async () => {
    const bridge = await loadBridge();
    const { bus, events } = createFakePi();
    bridge({ events } as any);
    const received = captureBlocked(bus);

    const longQuestion = "This is a very long question that exceeds the truncation limit and should be cut short";
    events.emit(ASK_USER_PROMPT_EVENT, {
      questions: [{ question: longQuestion, header: "", multiSelect: false, options: [] }],
    });
    events.emit(ASK_USER_BLOCKED_EVENT, { active: true });

    expect(received[0].active).toBe(true);
    expect(received[0].label).toBe(`❓ ${longQuestion.slice(0, 40)}`);
  });

  it("uses the fallback label when no prompt event was emitted", async () => {
    const bridge = await loadBridge();
    const { bus, events } = createFakePi();
    bridge({ events } as any);
    const received = captureBlocked(bus);

    events.emit(ASK_USER_BLOCKED_EVENT, { active: true });

    expect(received[0].active).toBe(true);
    expect(received[0].label).toBe("Waiting for your answer");
  });

  it("does nothing when HERDR_ENV is not set", async () => {
    const saved = process.env.HERDR_ENV;
    delete process.env.HERDR_ENV;
    try {
      vi.resetModules();
      const bridge = await loadBridge();
      const { bus, events } = createFakePi();
      bridge({ events } as any);

      const received = captureBlocked(bus);
      events.emit(ASK_USER_BLOCKED_EVENT, { active: true });

      // Bridge was never installed → no herdr:blocked emitted.
      expect(received).toHaveLength(0);
    } finally {
      process.env.HERDR_ENV = saved;
      vi.resetModules();
    }
  });
});
