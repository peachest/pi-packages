/**
 * Herdr Ask-Bridge — pi extension
 *
 * Problem: when the agent calls `ask_user_question`, the Herdr pane icon stays
 * "working" — indistinguishable from a normal agent turn. The user gets no
 * visual cue that the agent is blocked waiting for human input.
 *
 * Root cause: `ask_user_question` (from @juicesharp/rpiv-ask-user-question)
 * already emits `rpiv:ask-user:blocked` ({ active: true/false }) around the
 * questionnaire. But Herdr's pi integration (herdr-agent-state.ts) listens for
 * `herdr:blocked` — the event pi-subagents and pi-guardrails emit. Nobody
 * bridges the two.
 *
 * This extension is that bridge. It listens to `rpiv:ask-user:blocked` and
 * re-emits `herdr:blocked` with a label derived from the preceding
 * `rpiv:ask-user:prompt` event (the first question's header). The existing
 * herdr-agent-state.ts handles the rest: it flips the pane state to `blocked`,
 * which renders the distinct blocked glyph (when status_indicators = "symbols").
 *
 * Install: pi install ./packages/pi-herdr-ask-bridge  (from ~/projects/pi-mypackage)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Event channel emitted by @juicesharp/rpiv-ask-user-question while the questionnaire is shown. */
const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";

/** Event channel emitted just before, carrying the question metadata. */
const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";

/** The channel Herdr's pi integration listens on (herdr-agent-state.ts). */
const HERDR_BLOCKED_EVENT = "herdr:blocked";

const FALLBACK_LABEL = "Waiting for your answer";

type BlockedPayload = { active: boolean };

type PromptPayload = {
  questions: ReadonlyArray<{
    question: string;
    header: string;
    multiSelect: boolean;
    options: ReadonlyArray<{ label: string; description: string; hasPreview: boolean }>;
  }>;
};

export default function herdrAskBridge(pi: ExtensionAPI) {
  // No-op when not running inside Herdr — the bridge has nothing to feed.
  if (process.env.HERDR_ENV !== "1") return;

  // Capture the most recent prompt so we can attach a meaningful label to the
  // blocked signal. rpiv:ask-user:prompt always fires before
  // rpiv:ask-user:blocked { active: true } (see rpiv-ask-user-question/ask-user-question.ts).
  let pendingLabel = FALLBACK_LABEL;

  pi.events.on(ASK_USER_PROMPT_EVENT, (data: unknown) => {
    const payload = data as PromptPayload | undefined;
    const first = payload?.questions?.[0];
    if (first) {
      // header is the short chip (≤16 chars per the tool spec); prefer it,
      // fall back to a truncated question if the agent omitted the header.
      const header = first.header?.trim();
      pendingLabel = header ? `❓ ${header}` : `❓ ${first.question.slice(0, 40)}`;
    }
  });

  pi.events.on(ASK_USER_BLOCKED_EVENT, (data: unknown) => {
    const payload = data as BlockedPayload | undefined;
    const active = payload?.active === true;
    if (active) {
      pi.events.emit(HERDR_BLOCKED_EVENT, { active: true, label: pendingLabel });
    } else {
      pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
    }
  });
}
