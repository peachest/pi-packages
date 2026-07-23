/* ------------------------------------------------------------------ */
/*  Pi Wishlist — add command                                         */
/* ------------------------------------------------------------------ */

import { t } from "../state/i18n-bridge.ts";
import { getPackage, addPackage, updatePackage } from "../data/wishlist.ts";
import { trackPackage } from "../data/tracker.ts";
import type { CommandResult } from "./types.ts";

/**
 * Add a package to the wishlist.
 * Returns the normalized key of the added package.
 */
export async function handleAdd(
  args: string[],
): Promise<CommandResult<{ addedKey: string; hasNote: boolean }>> {
  let source = args[0];
  if (!source) {
    return { success: false, error: t("cli.addUsage", "please enter a package name") }; // ponytail: skip --note doc for now
  }

  const noteIdx = args.indexOf("--note");
  const notes = noteIdx !== -1 ? args.slice(noteIdx + 1).join(" ") : undefined;

  // Normalize source key
  if (!source.startsWith("npm:") && !source.startsWith("git:")) {
    source = `npm:${source}`;
  }

  const existing = getPackage(source);
  if (existing) {
    return { success: false, error: t("cli.alreadyExists", "{name} is already in the wishlist").replace("{name}", source.replace(/^npm:/, "")) };
  }

  addPackage(source, source, notes);

  // Trigger initial data fetch
  try {
    const result = await trackPackage(source);
    const sources: Record<string, unknown> = {};
    if (result.npm) sources.npm = result.npm;
    if (result.github) sources.github = result.github;
    updatePackage(source, { sources: sources as Record<string, unknown>, lastChecked: new Date().toISOString() });
  } catch (err) {
    // ponytail: package saved, data fetch failed — user can refresh later
  }

  return { success: true, data: { addedKey: source, hasNote: !!notes } };
}