/* ------------------------------------------------------------------ */
/*  Pi Wishlist — shared edit-note handler                            */
/* ------------------------------------------------------------------ */

import { t } from "../state/i18n-bridge.ts";
import { updatePackage, getPackage } from "./wishlist.ts";

/**
 * Update the note for a package.
 * Returns null on success, or an error message string.
 */
export function handleEditNote(key: string, note: string): string | null {
  const entry = getPackage(key);
  if (!entry) return t("cli.notInWishlist", "{name} is not in the wishlist").replace("{name}", key.replace(/^npm:/, ""));
  updatePackage(key, { notes: note });
  return null;
}

/**
 * Parse edit args: `<sourceKey> [--note <text>]`
 */
export function parseEditArgs(args: string[]): { key: string; note: string } | { error: string } {
  if (args.length === 0) return { error: t("cli.editUsage", "usage: edit <sourceKey> --note <text>") };
  const key = args[0];
  const noteIdx = args.indexOf("--note");
  const note = noteIdx !== -1 ? args.slice(noteIdx + 1).join(" ") : "";
  return { key, note };
}