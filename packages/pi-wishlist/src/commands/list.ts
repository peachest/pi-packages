/* ------------------------------------------------------------------ */
/*  Pi Wishlist — list command                                        */
/* ------------------------------------------------------------------ */

import { listPackages } from "../data/wishlist.ts";
import type { WishlistEntry } from "../data/types.ts";
import type { CommandResult } from "./types.ts";

/**
 * List all packages in the wishlist.
 */
export async function handleList(
  _args: string[],
): Promise<CommandResult<Array<{ key: string; entry: WishlistEntry }>>> {
  const packages = listPackages();
  return { success: true, data: packages };
}