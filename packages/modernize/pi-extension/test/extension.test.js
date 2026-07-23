import assert from "node:assert/strict";
import test from "node:test";

import modernizeExtension from "../index.js";

function createPiHarness() {
  const events = new Map();
  const commands = new Map();
  const appendedEntries = [];

  const pi = {
    on(eventName, handler) {
      events.set(eventName, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    sendMessage() {},
    sendUserMessage() {},
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
  };

  modernizeExtension(pi);
  return { events, commands, appendedEntries };
}

function createEventContext(overrides = {}) {
  return { ui: { notify() {} }, ...overrides };
}

test("extension registers modernize command", () => {
  const { commands } = createPiHarness();
  assert.ok(commands.has("modernize"));
});

test("extension subscribes to before_agent_start and input events", () => {
  const { events } = createPiHarness();
  assert.ok(events.has("before_agent_start"));
  assert.ok(events.has("input"));
});

test("proactive mode: injects instructions when system prompt mentions .go file", async () => {
  const { events, commands } = createPiHarness();
  const ctx = createEventContext();

  // Default is proactive, no need to toggle
  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Read main.go and server.go' },
    ctx,
  );

  assert.ok(result, "should return modified system prompt");
  assert.ok(result.systemPrompt.includes("MODERNIZE MODE"), "should contain MODERNIZE MODE header");
  assert.ok(result.systemPrompt.includes("Go Modern Features"), "should include Go reference");
  assert.ok(!result.systemPrompt.includes("TypeScript Modern Features"), "should NOT include TS reference when no ts/js files");
});

test("proactive mode: injects instructions when system prompt mentions .ts file", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext();

  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Check app.ts and types.ts' },
    ctx,
  );

  assert.ok(result, "should return modified system prompt");
  assert.ok(result.systemPrompt.includes("MODERNIZE MODE"), "should contain MODERNIZE MODE header");
  assert.ok(result.systemPrompt.includes("TypeScript / JavaScript Modern Features"), "should include TS/JS reference");
});

test("proactive mode: injects instructions when system prompt mentions .js file", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext();

  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Edit utils.js' },
    ctx,
  );

  assert.ok(result, "should return modified system prompt");
  assert.ok(result.systemPrompt.includes("MODERNIZE MODE"));
});

test("proactive mode: handles tsx/jsx/mjs/cjs file extensions", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext();

  const tsx = await events.get("before_agent_start")(
    { systemPrompt: 'Check component.tsx' },
    ctx,
  );
  assert.ok(tsx.systemPrompt.includes("TypeScript / JavaScript Modern Features"), "tsx triggers TS reference");

  const jsx = await events.get("before_agent_start")(
    { systemPrompt: 'Check component.jsx' },
    ctx,
  );
  assert.ok(jsx.systemPrompt.includes("TypeScript / JavaScript Modern Features"), "jsx triggers TS/JS reference");
});

test("proactive mode: injects both Go and TS when both present", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext();

  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Fix server.go and app.ts' },
    ctx,
  );

  assert.ok(result.systemPrompt.includes("Go Modern Features"), "should include Go reference");
  assert.ok(result.systemPrompt.includes("TypeScript / JavaScript Modern Features"), "should include TS/JS reference");
});

test("proactive mode: does NOT inject for unrelated file types", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext();

  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Read README.md and Dockerfile' },
    ctx,
  );

  assert.equal(result, undefined, "should not modify prompt for unrelated files");
});

test("proactive mode: does NOT inject when no files mentioned", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext();

  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Write a summary of the project' },
    ctx,
  );

  assert.equal(result, undefined, "should not modify prompt when no recognized files");
});

test("/modernize reactive disables injection", async () => {
  const { events, commands } = createPiHarness();
  const ctx = createEventContext();

  await commands.get("modernize").handler("reactive", ctx);

  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Edit main.go' },
    ctx,
  );

  assert.equal(result, undefined, "should not inject in reactive mode");
});

test("/modernize proactive re-enables injection after reactive", async () => {
  const { events, commands } = createPiHarness();
  const ctx = createEventContext();

  await commands.get("modernize").handler("reactive", ctx);
  await commands.get("modernize").handler("proactive", ctx);

  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Edit main.go' },
    ctx,
  );

  assert.ok(result, "should inject again after switching back to proactive");
  assert.ok(result.systemPrompt.includes("MODERNIZE MODE"));
});

test("/modernize on enables proactive mode", async () => {
  const { events, commands } = createPiHarness();
  const ctx = createEventContext();

  await commands.get("modernize").handler("on", ctx);
  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Edit main.go' },
    ctx,
  );
  assert.ok(result, "/modernize on enables proactive");
});

test("/modernize off disables injection", async () => {
  const { events, commands } = createPiHarness();
  const ctx = createEventContext();

  await commands.get("modernize").handler("off", ctx);
  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Edit main.go' },
    ctx,
  );
  assert.equal(result, undefined, "/modernize off disables injection");
});

test("stop modernize switches to reactive mode", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext();

  await events.get("input")({ text: "stop modernize", source: "interactive" }, ctx);

  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Edit main.go' },
    ctx,
  );
  assert.equal(result, undefined, "stop modernize disables injection");
});

test("normal mode switches to reactive mode", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext();

  await events.get("input")({ text: "normal mode", source: "interactive" }, ctx);

  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Edit main.go' },
    ctx,
  );
  assert.equal(result, undefined, "'normal mode' disables injection");
});

test("input commands are case insensitive", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext();

  await events.get("input")({ text: "STOP MODERNIZE", source: "interactive" }, ctx);
  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Edit main.go' },
    ctx,
  );
  assert.equal(result, undefined);

  // Reset
  const ctx2 = createEventContext();
  await events.get("input")({ text: "Normal Mode", source: "interactive" }, ctx2);
  const result2 = await events.get("before_agent_start")(
    { systemPrompt: 'Edit main.go' },
    ctx2,
  );
  assert.equal(result2, undefined);
});

test("/modernize status reports current mode", async () => {
  const { commands } = createPiHarness();
  const ctx = createEventContext();

  await commands.get("modernize").handler("", ctx);
  await commands.get("modernize").handler("bogus", ctx);
});

test("/modernize persists mode via appendEntry", async () => {
  const { commands, appendedEntries } = createPiHarness();
  const ctx = createEventContext();

  await commands.get("modernize").handler("reactive", ctx);

  const entry = appendedEntries.find(e => e.customType === "modernize-mode");
  assert.ok(entry, "should append a modernize-mode entry");
  assert.equal(entry.data.mode, "reactive");
});

test("stop modernize also persists to session", async () => {
  const { events, appendedEntries } = createPiHarness();
  const ctx = createEventContext();

  await events.get("input")({ text: "stop modernize", source: "interactive" }, ctx);

  const entry = appendedEntries.find(e => e.customType === "modernize-mode");
  assert.ok(entry, "stop modernize should append a modernize-mode entry");
  assert.equal(entry.data.mode, "reactive");
});

test("session_start restores persisted mode from entries", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext({
    sessionManager: {
      getBranch: () => [
        { type: "custom", customType: "modernize-mode", data: { mode: "reactive" } },
      ],
    },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);

  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Edit main.go' },
    ctx,
  );
  assert.equal(result, undefined, "should restore reactive mode from session entries");
});

test("session_start with proactive entry stays proactive", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext({
    sessionManager: {
      getBranch: () => [
        { type: "custom", customType: "modernize-mode", data: { mode: "proactive" } },
      ],
    },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);

  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Edit main.go' },
    ctx,
  );
  assert.ok(result, "should restore proactive mode from session entries");
});

test("session_start without entries defaults to proactive", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext({
    sessionManager: {
      getBranch: () => [],
    },
  });

  await events.get("session_start")({ reason: "new" }, ctx);

  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Edit main.go' },
    ctx,
  );
  assert.ok(result, "new session defaults to proactive");
});

test("input punctuation does not prevent deactivation", async () => {
  const { events } = createPiHarness();
  const ctx = createEventContext();

  await events.get("input")({ text: "normal mode.", source: "interactive" }, ctx);
  const result = await events.get("before_agent_start")(
    { systemPrompt: 'Edit main.go' },
    ctx,
  );
  assert.equal(result, undefined, "'normal mode.' with period still triggers deactivation");
});