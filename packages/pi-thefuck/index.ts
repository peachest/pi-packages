// SPDX-License-Identifier: MIT
// pi-thefuck — Undo the last failed tool call, like thefuck for pi agent

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";


const DOUBLE_TAP_THRESHOLD_MS = 300;
const CONTINUE_CUSTOM_TYPE = "__invisible_continue";

/**
 * Find the last failed tool call within the most recent assistant batch.
 *
 * Walks backwards from the tail to find the last assistant message, then
 * checks only the toolResults belonging to that assistant's toolCalls.
 * If that batch has no failures, returns null — we don't reach across
 * multiple assistant turns.
 */
function findLastFailedToolCall(messages: any[]): string | null {
  // 1. Find the last assistant message with toolCalls
  let lastAssistantToolCallIds: Set<string> | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.content) {
      const toolCalls = msg.content.filter(
        (c: any) => c.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        lastAssistantToolCallIds = new Set(
          toolCalls.map((c: any) => c.id),
        );
        break;
      }
    }
  }

  if (!lastAssistantToolCallIds) return null;

  // 2. Check toolResults in the same range for errors
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.role === "toolResult" &&
      msg.isError === true &&
      lastAssistantToolCallIds.has(msg.toolCallId)
    ) {
      return msg.toolCallId;
    }
  }

  return null;
}

function filterFuckedMessages(
  messages: any[],
  toolCallIds: Set<string>,
): any[] | null {
  let changed = false;
  const modified = messages.flatMap((msg) => {
    if (msg.role === "toolResult" && toolCallIds.has(msg.toolCallId)) {
      changed = true;
      return [];
    }
    if (msg.role === "assistant" && msg.content) {
      const filtered = msg.content.filter(
        (block: any) =>
          block.type !== "toolCall" || !toolCallIds.has(block.id),
      );
      if (filtered.length !== msg.content.length) {
        changed = true;
        if (filtered.length === 0) return [];
        return [{ ...msg, content: filtered }];
      }
    }
    return [msg];
  });
  return changed ? modified : null;
}

export default function (pi: ExtensionAPI) {
  let fuckedToolCallIds: Set<string> | null = null;

  pi.on("session_start", (_event, ctx) => {
    fuckedToolCallIds = new Set();

    // Double-tap F shortcut — like pi-bump's double Enter
    // Uses raw string comparison because Key.f doesn't exist in the Key enum
    // and decodePrintableKey may not be exposed at runtime.
    let lastFTime = 0;
    ctx.ui.onTerminalInput((data) => {
      // data is the raw terminal input; plain f/F are just "f" / "F"
      if (data !== "f" && data !== "F") return;

      // Only trigger when editor is empty (user is idle, not typing)
      const text = ctx.ui.getEditorText().trim();
      if (text.length > 0) return;

      const now = Date.now();
      if (now - lastFTime < DOUBLE_TAP_THRESHOLD_MS) {
        lastFTime = 0;
        if (ctx.isIdle() && !ctx.hasPendingMessages()) {
          undoToolCall(ctx, pi, fuckedToolCallIds);
        }
        return { consume: true };
      }
      lastFTime = now;
    });
  });

  pi.on("session_shutdown", () => {
    fuckedToolCallIds = null;
  });

  pi.on("context", (event) => {
    if (!fuckedToolCallIds || fuckedToolCallIds.size === 0) return;
    const modified = filterFuckedMessages(
      event.messages as any[],
      fuckedToolCallIds,
    );
    if (modified) return { messages: modified };
  });

  pi.registerCommand("fuck", {
    description: "Undo the last failed tool call (like thefuck)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await undoToolCall(ctx, pi, fuckedToolCallIds);
    },
  });
}

async function undoToolCall(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  fuckedToolCallIds: Set<string> | null,
): Promise<void> {
  if (!fuckedToolCallIds) {
    ctx.ui.notify("No active session", "error");
    return;
  }

  const branch = ctx.sessionManager.getBranch();
  const messages = branch
    .filter((e: any) => e.type === "message" && e.message)
    .map((e: any) => e.message);

  const toolCallId = findLastFailedToolCall(messages);
  if (!toolCallId) {
    ctx.ui.notify("No failed tool calls to undo", "warning");
    return;
  }

  fuckedToolCallIds.add(toolCallId);

  pi.sendMessage(
    {
      customType: CONTINUE_CUSTOM_TYPE,
      content: `Continue — undone tool call ${toolCallId}`,
      details: { fuckedToolCallIds: [...fuckedToolCallIds] },
      display: false,
    },
    { triggerTurn: true },
  );

  ctx.ui.notify(`Fucked ${toolCallId.slice(0, 25)}..., retrying`, "info");
}