# Context Injection Patterns in Pi Extensions

> **Learned from:** `@m4riok/pi-ide-bridge@0.2.0` and `pi-session-search@1.4.3`
> **Focus:** How these extensions hook into pi events to inject content into the LLM's conversation view.
> **Relevance:** Directly applicable to the skill-presets package's `context` event injection design.

---

## 1. Core Patterns

### Pattern A: `before_agent_start` → return `{ message: CustomMessage }` (pi-ide-bridge)

pi-ide-bridge injects **editor context** (active file, cursor position, open files, selection) on every agent turn via the `before_agent_start` event:

```typescript
// pi-ide-bridge/src/runtime.ts (simplified)
pi.on('before_agent_start', async (_event, _ctx) => {
  // 1. Check for pending rejected change from last turn
  if (pendingRejectedChange) {
    const rejected = pendingRejectedChange;
    pendingRejectedChange = undefined;
    return {
      message: {
        customType: 'pi-ide-bridge-rejected-change',
        display: false,
        content: [
          'User rejected a proposed edit in the previous step.',
          `File: ${rejected.filePath}`,
          '--- BEFORE ---',
          rejected.beforeText,
          '--- AFTER (REJECTED) ---',
          rejected.afterText,
        ].join('\n'),
        details: rejected,
      },
    };
  }

  // 2. Inject editor context
  if (!liveContext || !liveContext.openFiles?.length) return;

  const active = liveContext.openFiles.find(f => f.isActive) || liveContext.openFiles[0];
  return {
    message: {
      customType: 'pi-ide-bridge-editor-context',
      display: false,
      content: [
        '[IDE Context]',
        `Active file: ${active.path} — line ${active.cursor?.line}, col ${active.cursor?.character}`,
        `Selected: ${selectedInfo}`,
        `Open files: ${openFileNames.join(', ')}`,
      ].join('\n'),
      details: liveContext,
    },
  };
});
```

**Key mechanics:**
- `before_agent_start` handler can return `{ message: CustomMessage }` — pi injects this message into the conversation **before** the agent processes the user's prompt.
- `display: false` makes it invisible in the TUI but the LLM still sees it.
- The handler fires on **every turn**, so context is always fresh.
- Only one message can be returned per firing. If both rejected-change and editor-context exist, rejected-change wins (early return).

### Pattern B: `session_start` → `pi.sendMessage()` (pi-session-search)

pi-session-search injects a **recent sessions primer** once at session start:

```typescript
// pi-session-search/src/index.ts (simplified)
function injectPrimer(ctx) {
  if (!sessionIndex || sessionIndex.size() === 0) return;

  // Dedup: don't inject twice on /resume or re-open
  const alreadyInjected = ctx.sessionManager
    .getEntries()
    .some(e => e.type === 'custom_message' && e.customType === 'pi-session-search-primer');
  if (alreadyInjected) return;

  const sessions = sessionIndex.list({ project: projectSlug, limit: 5 });
  const primer = formatSessions(sessions);

  pi.sendMessage({
    customType: 'pi-session-search-primer',
    content: primer,
    display: false,
    details: { sessionCount: sessions.length },
  });
}

pi.on('session_start', async (_event, ctx) => {
  // ... index initialization ...
  injectPrimer(ctx);
});
```

**Key mechanics:**
- `pi.sendMessage()` with `display: false` injects a `CustomMessage` into the session.
- Called during `session_start`, so the primer appears **before** any user message — the LLM sees it as pre-existing context.
- **Dedup via `sessionManager.getEntries()`** — scans existing entries for the same `customType` to avoid double-injection on session resume.
- The primer is persisted as a `custom_message` entry in the session file (unlike `before_agent_start` which is transient).

### Pattern C: `appendEntry` for persistent state (pi-ide-bridge)

pi-ide-bridge uses `appendEntry` to persist state that must survive across sessions:

```typescript
// Persist approval mode change
function persistApprovalMode(pi, mode) {
  pi.appendEntry('pi-ide-bridge-approval-mode', { mode, updatedAt: Date.now() });
}

// Read back on session_start
pi.on('session_start', async (_event, ctx) => {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'custom') continue;

    if (entry.customType === 'pi-ide-bridge-approval-mode') {
      mode = entry.data.mode;  // Restore state
      break;
    }

    if (entry.customType === 'pi-ide-bridge-rejected-change') {
      pendingRejectedChange = entry.data;  // Restore pending rejection
    }
  }
});
```

**Key mechanics:**
- `appendEntry` creates a `type: "custom"` entry (NOT `"custom_message"`) — persisted in session file but **never sent to LLM**.
- On `session_start`, iterate `sessionManager.getEntries()` in reverse to find the most recent state.
- Used for: approval mode, rejected changes (which are then re-injected via `before_agent_start` on the next turn).

---

## 2. Key Differences

| Dimension | pi-ide-bridge | pi-session-search |
|---|---|---|
| **Injection event** | `before_agent_start` (every turn) | `session_start` (once) |
| **Injection method** | Return `{ message }` from handler | `pi.sendMessage()` |
| **Persistence** | Transient (not saved to session) | Persisted as `custom_message` entry |
| **Content freshness** | Always current (re-injected each turn) | Frozen at session start |
| **Dedup needed?** | No (transient, never accumulates) | Yes (persisted, must check entries) |
| **Prefix cache impact** | Low — `before_agent_start` message appears before user prompt, doesn't modify existing messages | Low — injected once at start, stays in prefix |
| **Compaction survival** | Automatic (re-injected next turn) | Summarized lossy (persisted message gets compacted) |
| **State tracking** | `appendEntry` for persistent state, in-memory for live context | In-memory index, no `appendEntry` |

### Why pi-session-search switched from `before_agent_start` to `session_start`

The source code documents a critical lesson (comment in `index.ts`):

> Historical note: earlier versions injected this on every `before_agent_start` hook. That was buggy in two ways:
> (1) The custom message landed AFTER the user's message in history, so the model responded to the primer instead of the user's actual question.
> (2) The relative dates ("8m ago") drifted turn-to-turn, breaking provider prefix caches.

**Implication for presets:** This validates our `context` event approach over `before_agent_start`. The `context` event operates on the full message array and lets us **append at the end** — we control exactly where the injection lands. `before_agent_start` only lets you return a single message that pi places at a fixed position.

---

## 3. Best Practices & Pitfalls

### ✅ Best practices observed

1. **Use `display: false` for invisible context.** Both extensions do this. The LLM sees the content; the user doesn't see clutter. Note: `display` is purely a UI flag — it does NOT hide content from the LLM.

2. **Dedup persisted injections.** pi-session-search checks `sessionManager.getEntries()` before injecting. Without this, `/resume` or session re-open would double-inject. This is essential for any `sendMessage`-based injection.

3. **Persist state with `appendEntry`, not `sendMessage`.** pi-ide-bridge uses `appendEntry` for approval mode and rejected changes — state the LLM doesn't need to see but must survive restarts. `appendEntry` entries are never sent to the LLM.

4. **Read back state in reverse on `session_start`.** pi-ide-bridge iterates entries from newest to oldest, breaking on the most recent state. This handles multiple state changes within a session correctly.

5. **Keep injection content deterministic.** pi-session-search's switch from `before_agent_start` to `session_start` was partly driven by relative dates drifting ("8m ago" → "9m ago") which broke prefix caches. If content must change each turn, only the trailing portion of the cache is invalidated.

6. **Guard against missing context.** pi-ide-bridge checks `if (!liveContext || !liveContext.openFiles?.length) return;` before injecting. pi-session-search wraps `injectPrimer` in try/catch — "Primer is nice-to-have; never break startup over it."

7. **Use `customType` as a namespace.** Both extensions prefix with their package name: `pi-ide-bridge-editor-context`, `pi-session-search-primer`. This prevents collisions with other extensions.

### ⚠️ Pitfalls observed

1. **`before_agent_start` message lands AFTER user message.** pi-session-search learned this the hard way — the model responded to the primer instead of the user. The `context` event avoids this by letting you control array position.

2. **Persisted `sendMessage` content gets compacted.** pi-session-search's primer is a `custom_message` entry. When compaction runs, this entry is summarized (lossy) and may be discarded. The primer won't survive compaction — it's gone for the rest of the session. (pi-ide-bridge avoids this by using transient `before_agent_start` injection.)

3. **No event for `appendEntry` changes.** State stored via `appendEntry` is only readable on `session_start` by scanning entries. There's no pub/sub — if another extension changes state, you won't know until restart.

4. **SSE reconnection needed for external context.** pi-ide-bridge connects to a VSCode SSE stream and must handle reconnection with backoff. If the stream drops, `liveContext` goes stale. The extension implements exponential backoff reconnection.

5. **Timer cleanup on shutdown.** Both extensions carefully clean up timers in `session_shutdown`. pi-session-search tracks all timers in a `Set` and clears them to prevent stale callbacks crashing the process after teardown.

---

## 4. Interfaces & Contracts

### `before_agent_start` return type

```typescript
// Return from handler to inject a message before the agent processes the user prompt
interface BeforeAgentStartEventResult {
  message?: Pick<CustomMessage, 'customType' | 'content' | 'display' | 'details'>;
}
```

### `pi.sendMessage()` signature

```typescript
sendMessage<T = unknown>(message: {
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
}, options?: {
  triggerTurn?: boolean;    // default false — doesn't trigger agent turn
  deliverAs?: 'steer' | 'followUp' | 'nextTurn';
}): void;
```

### `pi.appendEntry()` signature

```typescript
appendEntry<T = unknown>(customType: string, data?: T): void;
// Creates a session entry of type "custom" (NOT sent to LLM, NOT in context messages)
```

### `CustomMessage` shape

```typescript
interface CustomMessage<T = unknown> {
  role: 'custom';
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;       // UI-only flag; does NOT affect LLM visibility
  details?: T;
  timestamp: number;
}
```

### `SessionEntry` types (for `sessionManager.getEntries()`)

```typescript
// "custom" — from appendEntry(), NOT in LLM context
{ type: 'custom'; customType: string; data: unknown; id: string; timestamp: string }

// "custom_message" — from sendMessage(), IN LLM context (sent to LLM as user message)
{ type: 'custom_message'; customType: string; content: ...; display: boolean; details: unknown; ... }
```

---

## 5. File Map

### pi-ide-bridge (`@m4riok/pi-ide-bridge@0.2.0`)

| File | Responsibility |
|---|---|
| `index.ts` | Re-export bridge |
| `src/runtime.ts` | **Main extension factory.** All event handlers, commands, tools. ~450 lines. |
| `src/types.ts` | Type definitions: `EditorContext`, `OpenFile`, `ApprovalMode`, `RejectedChange`, etc. |
| `src/ideBridgeClient.ts` | HTTP client to VSCode bridge: SSE context stream, diff approval, diagnostics. |
| `src/bridgeContract.ts` | Constants: ports, paths, env var names for the VSCode↔pi contract. |
| `src/approvalProxy.ts` | Parent/child approval proxy for subagent edit approval. |
| `src/editPreview.ts` | Preview edit operations before applying. |
| `src/status.ts` | TUI status bar widget for connection/approval state. |
| `src/installer.ts` | VSCode companion extension installer. |

**VSCode extension** (`pi-ide-bridge-vscode@0.2.4`):

| File | Responsibility |
|---|---|
| `src/extension.js` | VSCode activation, bridge server startup. |
| `src/bridge/server.js` | HTTP server: SSE `/context/stream`, `/openDiff`, `/closeDiff`, `/diagnostics`. |
| `src/context/editorContextService.js` | Tracks open files, selections, cursor positions. Pub/sub to SSE subscribers. |
| `src/bridge/auth.js` | Auth token generation and verification. |
| `src/bridge/bootstrapServer.js` | Bootstrap port discovery for pi↔VSCode handshake. |

### pi-session-search (`pi-session-search@1.4.3`)

| File | Responsibility |
|---|---|
| `src/index.ts` | **Main extension factory.** Lifecycle, primer injection, tools, commands. ~500 lines. |
| `src/config.ts` | Config file loading/saving (embedder config, sync intervals, extra dirs). |
| `src/session-index.ts` | Embedding-based session index (semantic search). |
| `src/fts-index.ts` | FTS5-based session index (full-text search, no embeddings needed). |
| `src/reader.ts` | Read session JSONL files into conversation text. |
| `src/parser.ts` | Parse session entries into structured data. |
| `src/embedder.ts` | Embedding provider abstraction (OpenAI, Mistral, Bedrock, Ollama). |
| `src/utils.ts` | Helpers: truncate, pathToSlug, formatRelativeDate. |
| `skills/session-history/SKILL.md` | Skill for using session search tools. |

---

## 6. Dependencies & Stack

| | pi-ide-bridge | pi-session-search |
|---|---|---|
| **Runtime deps** | `string-width` | None (zero deps) |
| **Pi API** | `@earendil-works/pi-coding-agent` (type only) | `@earendil-works/pi-coding-agent` (type only) |
| **Typebox** | Yes (for tool params) | Yes (for tool params) |
| **External service** | VSCode extension (HTTP+SSE on localhost) | Optional: embedding APIs (OpenAI/Mistral/Bedrock/Ollama) |
| **Storage** | Session entries (`appendEntry`) + VSCode settings | SQLite FTS5 index + optional embedding vectors |
| **Build** | noEmit + jiti (`.ts` direct) | tsc build (`dist/index.js`) |

---

## 7. Synthesis: Implications for Skill Presets

### What we can directly reuse

1. **`context` event over `before_agent_start`** — Our research ticket #2 already confirmed this. pi-session-search's experience reinforces it: `before_agent_start` places the message at a fixed position (after user message), while `context` gives us full array control. We'll **append at end** for cache friendliness.

2. **`appendEntry` for preset load/offload state** — Exactly like pi-ide-bridge's approval mode pattern:
   ```typescript
   // On preset load
   pi.appendEntry('preset-op', { preset: 'ddd', action: 'load', timestamp: Date.now() });
   // On preset offload
   pi.appendEntry('preset-op', { preset: 'ddd', action: 'offload', timestamp: Date.now() });
   // On session_start, read back to determine final state
   ```

3. **Dedup pattern** — pi-session-search's `sessionManager.getEntries()` scan is the right pattern for checking if a primer or state has already been applied on resume.

4. **`customType` namespacing** — Use `preset-op` as the single customType for all load/offload operations (distinguished by `action` field), and `preset-context` for the transient injection CustomMessage.

### What we must do differently

1. **Transient injection, not persisted.** Both existing extensions either persist messages (pi-session-search, which gets compacted) or inject transiently via `before_agent_start` (pi-ide-bridge, but at a fixed position). Our approach: **transient `context` event injection** — best of both worlds. No persistence bloat, no compaction issues, full array control.

2. **Multiple skill content blocks per turn.** pi-ide-bridge injects one message per turn. We may need to inject multiple presets' worth of skill content. Solution: resolve all active preset skills into a single array (deduplicated), call `formatSkillsForPrompt` once, and inject as a single `CustomMessage` at the end of the array.

3. **No settle logic needed.** The original design included a settle mechanism for cache-cold restarts. This was **explicitly abandoned** in ticket #5: since transient injection doesn't persist skill content to the message list, there's nothing to settle. On restart, the active set is simply rebuilt from persistent entries and transient injection resumes.

### The complete injection architecture (informed by both examples)

```
session_start
  ├─ Read appendEntry history → replay load/offload → rebuild active set
  ├─ Auto-write default preset skills to settings.skills (respect existing '-' patterns)
  └─ Active set = set of preset names (not skills)

context event (every turn)
  ├─ Resolve active set preset names → skills list (deduplicated)
  ├─ Exclude skills already in system prompt (default preset skills)
  ├─ Filter out skill-manager-disabled skills
  ├─ formatSkillsForPrompt(activeSkills) → single XML block
  └─ return { messages: [...messages, customMsg] }  ← append at end

preset-load command
  ├─ activeSet.add(presetName)
  └─ appendEntry('preset-op', { preset, action: 'load', timestamp })

preset-off command
  ├─ activeSet.delete(presetName)
  └─ appendEntry('preset-op', { preset, action: 'offload', timestamp })

No settle logic. No session_compact handling needed.
  (appendEntry immune to compaction; transient injection re-applies every turn)
```
