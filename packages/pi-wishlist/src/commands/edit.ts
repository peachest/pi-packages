/* ------------------------------------------------------------------ */
/*  Pi Wishlist — edit command                                        */
/* ------------------------------------------------------------------ */

import { parseEditArgs, handleEditNote } from "../data/edit-note.ts";
import type { CommandResult } from "./types.ts";

/**
 * Edit (or clear) the note for a wishlist package.
 */
export async function handleEdit(
  args: string[],
): Promise<CommandResult<{ key: string; note: string }>> {
  const parsed = parseEditArgs(args);
  if ("error" in parsed) {
    return { success: false, error: parsed.error };
  }

  const err = handleEditNote(parsed.key, parsed.note);
  if (err) {
    return { success: false, error: err };
  }

  return { success: true, data: { key: parsed.key, note: parsed.note || "" } };
}