/* ------------------------------------------------------------------ */
/*  Pi Wishlist — remove command                                      */
/* ------------------------------------------------------------------ */

import { t } from "../state/i18n-bridge.ts";
import { listPackages, removePackage } from "../data/wishlist.ts";
import type { CommandResult } from "./types.ts";

/**
 * Remove a package from the wishlist by key or index.
 * Returns the key of the removed package.
 */
export async function handleRemove(
  args: string[],
): Promise<CommandResult<{ removedKey: string }>> {
  const target = args[0];
  if (!target) {
    return { success: false, error: t("cli.removeUsage", "usage: /wish remove <sourceKey>") };
  }

  const packages = listPackages();

  const idx = parseInt(target, 10);
  let sourceKey = target;
  if (!isNaN(idx) && idx >= 1 && idx <= packages.length) {
    sourceKey = packages[idx - 1].key;
  }

  // Remove directly — removePackage returns false if key not found
  if (!removePackage(sourceKey)) {
    return { success: false, error: t("cli.notInWishlist", "{name} is not in the wishlist").replace("{name}", sourceKey) };
  }
  return { success: true, data: { removedKey: sourceKey } };
}