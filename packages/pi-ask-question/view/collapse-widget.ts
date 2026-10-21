import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Stable widget key — the four lifecycle exits clear exactly this key. */
export const ASK_USER_WIDGET_KEY = "ask_user";

/**
 * Persistent-widget copy while the questionnaire dialog is collapsed:
 * `❓ ask_user 等待回答（已答 n/m）· <key> 重新打开`. `answered`/`total` are read
 * live from the session at render time, so the widget never needs re-setting on
 * answer changes.
 */
export function buildWidgetLine(answered: number, total: number, collapseKeyDisplay: string): string {
	return `❓ ask_user 等待回答（已答 ${answered}/${total}）· ${collapseKeyDisplay} 重新打开`;
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
