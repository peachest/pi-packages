# Research Ticket #2: Context Event Mechanics & Message Injection Viability

> Source: `@earendil-works/pi-coding-agent` (resolved via local `node_modules`)
> Package root: `node_modules/@earendil-works/pi-coding-agent/dist/`
> Agent-core root: `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/`

All file paths below are relative to the pi-coding-agent `dist/` directory unless
otherwise noted. Line numbers cite the compiled `.js` (the `.d.ts` is cited where
it is the authoritative type source).

---

## Summary of the data flow (the single most important diagram)

For **every** assistant response, `pi-agent-core`'s `streamAssistantResponse`
runs this pipeline (`pi-agent-core/dist/agent-loop.js`, function
`streamAssistantResponse`):

```
context.messages (AgentMessage[])
   │
   ▼  ①  config.transformContext(messages)   ←  emitContext()  [the "context" event]
   │
   ▼  ②  config.convertToLlm(messages)       ←  convertToLlmWithBlockImages → convertToLlm
   │
   ▼  ③  build llmContext { systemPrompt, messages: llmMessages, tools }
   │
   ▼  ④  streamFunction(model, llmContext, opts)
   │       └─ onPayload(payload, model)       ←  emitBeforeProviderRequest()  [the "before_provider_request" event]
   │       └─ transformHeaders(headers)       ←  emitBeforeProviderHeaders()
   │
   ▼  ⑤  provider HTTP call
```

Key ordering facts:
- **`context` fires BEFORE `convertToLlm`** — it operates on `AgentMessage[]`
  (the rich, typed message array that includes `CustomMessage`, `BashExecutionMessage`,
  etc.).
- **`before_provider_request` fires AFTER `convertToLlm`** — it operates on the
  final provider-specific payload (raw JSON body), which is `unknown`-typed.
- The **system prompt is NOT part of the messages array** — it lives in
  `context.systemPrompt` and is injected into `llmContext` separately at step ③.

Source: `pi-agent-core/dist/agent-loop.js` → `streamAssistantResponse`:

```js
// Apply context transform if configured (AgentMessage[] → AgentMessage[])
let messages = context.messages;
if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
}
// Convert to LLM-compatible messages (AgentMessage[] → Message[])
const llmMessages = await config.convertToLlm(messages);
// Build LLM context
const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
};
```

---

## Q1. When does `context` fire?

**Answer: On every provider request (every turn of the agent loop), including
after compaction.** It is NOT a session-start-only event.

### Evidence

The `context` event is emitted through `ExtensionRunner.emitContext()`, which is
wired into the `Agent` as `transformContext`:

`core/sdk.js` (lines ~223-227):
```js
transformContext: async (messages) => {
    const runner = extensionRunnerRef.current;
    if (!runner)
        return messages;
    return runner.emitContext(messages);
},
```

`transformContext` is called inside `streamAssistantResponse` in
`pi-agent-core/dist/agent-loop.js`. `streamAssistantResponse` is called once per
**turn** inside the `runLoop` while-loop. A single user prompt can produce many
turns (tool-call → result → next assistant response → …), and `context` fires
before **each** of those assistant responses.

### After compaction

Compaction rebuilds `agent.state.messages` from the session entries
(`core/agent-session.js`, inside the manual `compact()` method, ~line 1448):
```js
this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
const newEntries = this.sessionManager.getEntries();
const sessionContext = this.sessionManager.buildSessionContext();
this.agent.state.messages = sessionContext.messages;
```

After this rebuild, the `session_compact` event is emitted (~line 1455), and then
when the agent loop resumes (either via auto-retry on overflow, or the next user
prompt), `streamAssistantResponse` calls `transformContext` again on the now-
compacted `agent.state.messages`. **So yes — `context` fires after compaction,
on the compacted message set, and can re-inject content that compaction
destroyed.**

### When it does NOT fire

`context` does **not** fire at session start, session resume, or reload in
isolation. It only fires as part of `streamAssistantResponse`, i.e. when the
agent is about to make an LLM call. There is no "initial context assembly" hook
separate from the per-turn one.

---

## Q2. Can we return modified `messages`? Will pi use our array?

**Answer: Yes.** If a `context` handler returns `{ messages: [...] }`, that
array **replaces** the message array used for the rest of the pipeline
(convertToLlm → provider request). Multiple handlers chain: each receives the
output of the previous one.

### Evidence

`core/extensions/runner.js` → `emitContext()` (lines ~733-760):

```js
async emitContext(messages) {
    const ctx = this.createContext();
    let currentMessages = structuredClone(messages);   // ← deep clone of input
    for (const ext of this.extensions) {
        const handlers = ext.handlers.get("context");
        if (!handlers || handlers.length === 0) continue;
        for (const handler of handlers) {
            try {
                const event = { type: "context", messages: currentMessages };
                const handlerResult = await handler(event, ctx);
                if (handlerResult && handlerResult.messages) {
                    currentMessages = handlerResult.messages;   // ← replacement
                }
            } catch (err) { /* ... error emitted, chain continues ... */ }
        }
    }
    return currentMessages;   // ← this is what convertToLlm receives
}
```

Critical details:
1. **`structuredClone(messages)`** — the handler receives a *deep clone* of the
   current messages. Mutating the clone in place has no effect unless you return
   it. Returning `handlerResult.messages` is the canonical way to replace.
2. **Chaining** — extensions are iterated in registration order; each handler's
   returned `messages` becomes the input to the next handler. If handler A
   injects skill content and handler B does nothing, B still sees A's injection.
3. **The returned array flows into `convertToLlm`** which maps `CustomMessage`
   (role `"custom"`) to a `user` message (see Q5). So injecting
   `CustomMessage` entries with `display: false` **will** be seen by the LLM.
4. **`display` is irrelevant to LLM inclusion** — `convertToLlm` does not check
   `display`. It is purely a UI-rendering flag. A `CustomMessage` with
   `display: false` is still converted to a `user` message and sent to the
L
   provider. (`core/messages.js` → `convertToLlm`, the `"custom"` case.)

### Type confirmation

`core/extensions/types.d.ts`:
```ts
export interface ContextEventResult {
    messages?: AgentMessage[];
}
export interface ContextEvent {
    type: "context";
    messages: AgentMessage[];
}
```

The handler signature is:
```ts
on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
```

---

## Q3. Prefix cache impact

**Answer: Injecting messages into the `messages` array does NOT invalidate the
system-prompt prefix cache (the system prompt string is untouched). However,
message-level prefix caching IS affected by where you inject.**

### How it works

- The system prompt is a **separate field** (`llmContext.systemPrompt`), not part
  of `messages`. The `context` event only transforms `messages`; it never touches
  `systemPrompt`. So the system-prompt cache breakpoint (e.g. Anthropic's
  `cache_control` on the system block) stays valid regardless of what you inject
  into messages.
- For **message-level** prefix caching (Anthropic, DeepSeek, etc.), the cache key
  is the exact byte sequence of the message prefix. Injecting a new message:
  - **At the end** (appending after all existing messages): preserves the cache
    for all prior messages. ✅ Best for cache friendliness.
  - **At the beginning** (prepending before the first user message): invalidates
    the cache for every subsequent message. ❌ Worst case.
  - **In the middle**: invalidates the cache for everything after the injection
    point. ⚠️

### Practical recommendation

If you need to inject skill content that the LLM should see, **append it as a
`CustomMessage` at the end of the array** (or just before the final user
message, if you want the model to treat it as prior context). This keeps the
existing prefix cache intact. Appending at the very end means the injected
content is the last thing the model sees before generating — which is actually
ideal for "reminder"/"steering" style injections.

**Caveat:** Because `emitContext` does `structuredClone(messages)` and you return
a new array, the *object identity* changes every turn. This does not matter for
caching (caching is based on the serialized bytes, not JS object identity), but
it does mean you should inject **deterministically** — if the injected content
changes every turn, the trailing portion of the cache is invalidated each turn
anyway.

---

## Q4. Compaction survival

**Answer: Compaction SUMMARIZES `CustomMessage` entries (their text content is
fed to the summarization LLM) and then DISCARDS the originals. The skill
content is NOT preserved verbatim — it is lossily compressed into the summary.
However, the `context` event fires on the next turn after compaction, so you
CAN re-inject.**

### Evidence

#### 4a. CustomMessages are included in the summarization input

`core/compaction/compaction.js` → `getMessageFromEntryForCompaction()`:
```js
function getMessageFromEntryForCompaction(entry) {
    if (entry.type === "compaction") {
        return undefined;
    }
    return sessionEntryToContextMessages(entry)[0];
}
```

`sessionEntryToContextMessages` (in `core/session-manager.js`, ~line 166) maps
`custom_message` entries → `CustomMessage` (role `"custom"`). So custom messages
ARE extracted for summarization.

Then `generateSummaryWithUsage()` calls `convertToLlm(currentMessages)` which
converts `custom` role → `user` role with text content, then
`serializeConversation(llmMessages)` turns it all into text for the
summarization prompt. So the skill content IS seen by the summarizer — but only
as text to summarize, not to preserve.

#### 4b. CustomMessages in the summarized range are discarded

After summarization, `buildContextEntries()` (in `core/session-manager.js`,
~line 232) rebuilds the context: it keeps only the compaction entry + entries
from `firstKeptEntryId` onward. Everything before (including the original
`CustomMessage` entries) is omitted from `agent.state.messages`.

#### 4c. `isCutPointMessage` treats `custom` as a valid cut point

`core/compaction/compaction.js`:
```js
function isCutPointMessage(message) {
    switch (message.role) {
        case "user":
        case "assistant":
        case "bashExecution":
        case "custom":           // ← custom is a cut-point candidate
        case "branchSummary":
        case "compactionSummary":
            return true;
        case "toolResult":
            return false;
    }
    return false;
}
```

This means compaction can cut right before/after a `CustomMessage`, and the
message may end up on either side of the cut. If it's in the summarized range,
it's gone. If it's in the kept range, it survives — but you can't control which
side it lands on.

#### 4d. Re-injection after compaction

As established in Q1, after compaction `agent.state.messages` is rebuilt and the
next `streamAssistantResponse` call runs `transformContext` (emitContext) on the
new, compacted array. **So yes — a `context` handler can detect that compaction
happened (e.g. by checking for a `compactionSummary` message in the array, or by
tracking its own "last injected" state) and re-inject the skill content.**

You can also listen to the `session_compact` event (`SessionCompactEvent` in
`types.d.ts`) to set a "needs re-injection" flag, then re-inject on the next
`context` firing.

### Severity assessment

| Concern | Severity | Mitigation |
|---|---|---|
| Skill content lost on compaction | **High** if content is large and must be verbatim | Re-inject via `context` handler |
| Skill content summarized (lossy) | **Medium** — summary may drop details | Re-inject; don't rely on summary |
| Cut point may split skill content | **Low** — rare, and re-injection covers it | Re-inject |

---

## Q5. `appendEntry` vs `sendMessage`

**Answer: They serve fundamentally different purposes.**

| Mechanism | Entry type | Persisted? | Sent to LLM? | Survives compaction? |
|---|---|---|---|---|
| `appendEntry(customType, data)` | `"custom"` | ✅ Yes | ❌ No | N/A (never in context) |
| `sendMessage(msg, {triggerTurn:false})` | `"custom_message"` | ✅ Yes | ✅ Yes | Summarized (lossy) |
| `context` event injection | (transient) | ❌ No (not persisted) | ✅ Yes | Re-inject each turn |

### Evidence

#### `appendEntry` → `appendCustomEntry`

`core/session-manager.js` (~line 820):
```js
appendCustomEntry(customType, data) {
    const entry = {
        type: "custom",        // ← NOT "custom_message"
        customType,
        data,
        id: generateId(this.byId),
        parentId: this.leafId,
        timestamp: new Date().toISOString(),
    };
    this._appendEntry(entry);
    return entry.id;
}
```

And `sessionEntryToContextMessages` (~line 166) returns `[]` for `type === "custom"`:
```js
export function sessionEntryToContextMessages(entry) {
    if (entry.type === "message") { ... }
    if (entry.type === "custom_message") { ... }   // ← enters context
    if (entry.type === "branch_summary" && entry.summary) { ... }
    if (entry.type === "compaction") { ... }
    return [];   // ← "custom" entries fall through here
}
```

The docstring confirms: *"Plain custom entries are display/state entries and do
not participate in context."*

#### `sendMessage` → `sendCustomMessage` → `appendCustomMessageEntry`

`core/agent-session.js` → `sendCustomMessage()` (~line 1058). When not streaming
and `triggerTurn` is false/absent:
```js
else {
    this.agent.state.messages.push(appMessage);   // ← added to live agent state
    this.sessionManager.appendCustomMessageEntry(  // ← persisted as "custom_message"
        message.customType, message.content, message.display, message.details
    );
    this._emit({ type: "message_start", message: appMessage });
    this._emit({ type: "message_end", message: appMessage });
}
```

`appendCustomMessageEntry` (`core/session-manager.js` ~line 866) creates a
`"custom_message"` entry, which `sessionEntryToContextMessages` maps to a
`CustomMessage` (role `"custom"`) → enters LLM context via `convertToLlm`.

### Recommendation

- **(a) Injecting skill content the LLM sees:** Use the **`context` event**, not
  `sendMessage`. The `context` event is the cleanest mechanism:
  - It fires every turn, so content is always present.
  - It's transient (not persisted), so it doesn't bloat the session file.
  - It survives compaction automatically (re-injects next turn).
  - You control exactly where in the array it goes (cache-friendly appending).

  `sendMessage` with `triggerTurn: false` CAN work, but:
  - It persists a `custom_message` entry, which compaction will summarize (lossy).
  - It appends to `agent.state.messages` at call time — if called at session
    start, the content drifts to the middle of the array as the conversation
    grows, eventually getting compacted away.
  - It triggers `message_start`/`message_end` events (UI side effects).

- **(b) Recording load/offload operations persistently:** Use **`appendEntry`**.
  This creates a `"custom"` entry that is persisted to the session file but
  **never** enters LLM context. It's perfect for recording "skill X loaded at
  timestamp Y" audit trails. You can render it in the TUI via
  `registerEntryRenderer`.

### The hybrid pattern (recommended)

```
┌─────────────────────────────────────────────────────┐
│ session_start event                                  │
│  └─ appendEntry("skill_load", { skill, loaded })    │  ← persistent audit
├─────────────────────────────────────────────────────┤
│ context event (every turn)                           │
│  └─ return { messages: [...messages, skillMsg] }    │  ← transient LLM injection
├─────────────────────────────────────────────────────┤
│ session_compact event                                │
│  └─ set flag: "re-inject on next context"           │  ← compaction recovery
└─────────────────────────────────────────────────────┘
```

---

## Q6. `before_provider_request` alternative

**Answer: `before_provider_request` CAN replace the entire payload, but it is a
WORSE hook than `context` for message injection. Use `context`.**

### Evidence

`core/extensions/runner.js` → `emitBeforeProviderRequest()` (~line 762):
```js
async emitBeforeProviderRequest(payload) {
    const ctx = this.createContext();
    let currentPayload = payload;
    for (const ext of this.extensions) {
        const handlers = ext.handlers.get("before_provider_request");
        if (!handlers || handlers.length === 0) continue;
        for (const handler of handlers) {
            try {
                const event = {
                    type: "before_provider_request",
                    payload: currentPayload,
                };
                const handlerResult = await handler(event, ctx);
                if (handlerResult !== undefined) {
                    currentPayload = handlerResult;   // ← full replacement
                }
            } catch (err) { /* ... */ }
        }
    }
    return currentPayload;
}
```

Wired in `core/sdk.js` (~line 205):
```js
onPayload: async (payload, _model) => {
    const runner = extensionRunnerRef.current;
    if (!runner?.hasHandlers("before_provider_request")) {
        return payload;
    }
    return runner.emitBeforeProviderRequest(payload);
},
```

### Why `context` is better for message injection

| Dimension | `context` | `before_provider_request` |
|---|---|---|
| Operates on | `AgentMessage[]` (typed, rich) | `unknown` (raw provider JSON) |
| Fires before | `convertToLlm` | provider HTTP call (after convertToLlm) |
| Provider-agnostic? | ✅ Yes | ❌ No — payload shape differs per provider (Anthropic vs OpenAI vs Gemini) |
| Type safety | ✅ `AgentMessage[]` | ❌ `unknown` — you must reverse-engineer the payload format |
| Re-injection after compaction | ✅ Natural (fires every turn on current state) | ⚠️ Possible but you're patching raw JSON |
| Cache control | ✅ You control array position | ⚠️ You must understand the serialized format |

`before_provider_request` is designed for **low-level payload mutation** — e.g.,
injecting custom HTTP headers is better done via `before_provider_headers`, and
adding provider-specific fields (like Anthropic metadata, or OpenAI
`user`/`session_id`) is what `before_provider_request` is for. For injecting
**conversation content the LLM should see as messages**, `context` is the
correct, provider-agnostic, type-safe hook.

### When `before_provider_request` IS the right choice

- Adding provider-specific request fields that aren't messages (e.g., Anthropic
  `metadata.user_id`, OpenAI `session_id`).
- Mutating the payload in ways that can't be expressed as messages (e.g., forcing
  `max_tokens`, injecting `cache_control` breakpoints on specific message blocks
  — though note pi already manages cache breakpoints).
- Provider-specific workarounds that require raw payload access.

---

## Residual Risks & Caveations

1. **`structuredClone` cost**: `emitContext` deep-clones the entire message array
   every turn. For very long conversations (thousands of messages), this has a
   measurable cost. The clone is necessary for safety (handlers can't mutate the
   real state), but if your handler is a no-op, the clone still happens. There's
   no way to opt out. **Severity: Low** (mitigated by compaction keeping
   conversations short).

2. **Handler ordering**: Multiple `context` handlers chain in extension
   registration order. If two extensions both inject content, the order depends
   on load order. If your injection must be last (e.g., to appear at the end of
   the array), you may need to coordinate with other extensions or accept that
   another extension's injection could come after yours. **Severity: Low.**

3. **Compaction cut-point unpredictability**: Compaction may cut in the middle of
   a logical "turn" that includes your injected `CustomMessage` (if it was
   persisted via `sendMessage`). The `context`-event injection approach avoids
   this entirely because the injection is transient. **Severity: None** if using
   the recommended `context`-event pattern.

4. **No "context fired" signal to other handlers**: If extension A injects via
   `context` and extension B needs to know whether A injected, B must inspect the
   message array it receives (which will contain A's injection if A ran first).
   There's no explicit "injection happened" event. **Severity: Low.**

5. **`display: false` does NOT mean "hidden from LLM"**: This is a common
   misconception. `display` only controls TUI rendering. A `CustomMessage` with
   `display: false` is still converted to a `user` message and sent to the
   provider. This is confirmed by `convertToLlm` in `core/messages.js` which
   never reads `display`. **Severity: Info** (but important for security — don't
   put secrets in a `CustomMessage` thinking `display: false` hides them from the
   LLM).

---

## File reference index

| File (relative to `dist/`) | Key symbols |
|---|---|
| `core/extensions/runner.js` | `emitContext()` L733, `emitBeforeProviderRequest()` L762, `emitBeforeProviderHeaders()` L794 |
| `core/extensions/types.d.ts` | `ContextEvent`, `ContextEventResult`, `BeforeProviderRequestEvent`, `ExtensionAPI.on()` |
| `core/sdk.js` | `transformContext` wiring L223, `onPayload` wiring L205, `convertToLlmWithBlockImages` L139 |
| `core/messages.js` | `convertToLlm()` (custom→user mapping), `createCustomMessage()` |
| `core/session-manager.js` | `sessionEntryToContextMessages()` L166, `buildSessionContext()` L232, `appendCustomEntry()` L820, `appendCustomMessageEntry()` L866 |
| `core/compaction/compaction.js` | `getMessageFromEntryForCompaction()`, `generateSummaryWithUsage()`, `isCutPointMessage()`, `prepareCompaction()` |
| `core/agent-session.js` | `sendCustomMessage()` L1058, compaction rebuild L1448, `bindCore` sendMessage/appendEntry L1851/L1869 |
| `../pi-agent-core/dist/agent-loop.js` | `streamAssistantResponse()` (the pipeline), `runLoop()` (turn loop) |
| `../pi-agent-core/dist/agent.js` | `createLoopConfig()` L276 (wires `onPayload`, `transformContext`, `convertToLlm`) |
| `../pi-ai/dist/types.d.ts` | `SimpleStreamOptions.onPayload` (payload is `unknown`) |