import type { ActiveView } from "../../view/stateful-view.ts";

/**
 * Discriminated focus selector — single source of truth for "which view owns
 * focus this tick?" Priority order matches the dispatcher cascade
 * (`key-router.ts`) and the reducer's defensive clears (`state-reducer.ts`).
 *
 * Priority: notes > submit > options.
 */
export function selectActiveView(
	state: { activeSideEditor: "notes" | "reason" | null; currentTab: number },
	totalQuestions: number,
): ActiveView {
	if (state.activeSideEditor) return "notes";
	if (state.currentTab === totalQuestions) return "submit";
	return "options";
}
