import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { KEY_PLACEHOLDER } from "./dialog-copy.ts";
import { t } from "../state/i18n-bridge.ts";

/** Stable widget key — the four lifecycle exits clear exactly this key. */
export const ASK_USER_WIDGET_KEY = "ask_user";

const ANSWERED_PLACEHOLDER = "{answered}";
const TOTAL_PLACEHOLDER = "{total}";

/**
 * Canonical-English fallback for `widget_line` — rpiv-i18n has no interpolation, so
 * locale entries (en/zh) carry the `{answered}`/`{total}`/`{key}` placeholders and this
 * call site replaces them after lookup (same template idiom as the hint keys).
 */
const WIDGET_LINE_TEMPLATE =
	`❓ ask_user waiting for answers (${ANSWERED_PLACEHOLDER}/${TOTAL_PLACEHOLDER} answered) · ${KEY_PLACEHOLDER} to reopen`;

/**
 * Persistent-widget copy while the questionnaire dialog is collapsed:
 * `❓ ask_user waiting for answers (n/m answered) · <key> to reopen`. `answered`/`total`
 * are read live from the session at render time, so the widget never needs re-setting on
 * answer changes. `t` stays inside the function so live locale updates propagate.
 */
export function buildWidgetLine(answered: number, total: number, collapseKeyDisplay: string): string {
	return t("widget_line", WIDGET_LINE_TEMPLATE)
		.replace(ANSWERED_PLACEHOLDER, String(answered))
		.replace(TOTAL_PLACEHOLDER, String(total))
		.replace(KEY_PLACEHOLDER, collapseKeyDisplay);
}

/**
 * Widget component factory body (autoresearch parity): one width-adaptive line —
 * `truncateToWidth` against the viewport width, falling back to the terminal width
 * when pi renders without an explicit one.
 */
export function makeWidgetComponent(input: { tui: TUI; theme: Theme; readLine: () => string }): Component {
	const { tui, theme, readLine } = input;
	return {
		render(width: number): string[] {
			const safeWidth = Math.max(1, width || tui.terminal?.columns || 120);
			return [truncateToWidth(theme.fg("accent", readLine()), safeWidth)];
		},
		invalidate(): void {},
	};
}
