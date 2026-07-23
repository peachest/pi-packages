/* ------------------------------------------------------------------ */
/*  Pi Wishlist — stats command                                       */
/* ------------------------------------------------------------------ */

import { t } from "../state/i18n-bridge.ts";
import { getPackage } from "../data/wishlist.ts";
import type { WishlistEntry } from "../data/types.ts";
import type { CommandResult } from "./types.ts";

/**
 * Get detailed stats and event history for a package.
 */
export async function handleStats(
  args: string[],
): Promise<CommandResult<{ key: string; entry: WishlistEntry }>> {
  const sourceKey = args[0];
  if (!sourceKey) {
    return { success: false, error: t("cli.statsUsage", "usage: /wish stats <sourceKey>") };
  }

  const entry = getPackage(sourceKey);
  if (!entry) {
    return { success: false, error: t("cli.notFound", "could not find {key}").replace("{key}", sourceKey) };
  }

  return { success: true, data: { key: sourceKey, entry } };
}