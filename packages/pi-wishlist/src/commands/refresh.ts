/* ------------------------------------------------------------------ */
/*  Pi Wishlist — refresh command                                     */
/* ------------------------------------------------------------------ */

import { t } from "../state/i18n-bridge.ts";
import { clearAllCooldowns, runDailyCheck } from "../data/checker.ts";
import { loadWishlist } from "../data/wishlist.ts";
import type { CheckResult } from "../data/types.ts";
import type { CommandResult } from "./types.ts";

/**
 * Run a full wishlist refresh — clear cooldowns, re-check all packages.
 * Returns results and total package count.
 */
export async function handleRefresh(): Promise<CommandResult<{ results: CheckResult[]; totalPackages: number }>> {
  try {
    clearAllCooldowns();
    const results = await runDailyCheck();
    
    const totalPackages = Object.keys(loadWishlist().packages).length;
    return { success: true, data: { results, totalPackages } };
  } catch {
    return { success: false, error: t("cli.refreshFailed", "refresh failed") };
  }
}