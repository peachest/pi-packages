/* ------------------------------------------------------------------ */
/*  Pi Wishlist — search command                                      */
/* ------------------------------------------------------------------ */

import { searchPiPackages } from "../data/search.ts";
import type { SearchResult } from "../data/search.ts";
import type { CommandResult } from "./types.ts";

/**
 * Search pi packages by query string.
 */
export async function handleSearch(
  query: string,
): Promise<CommandResult<SearchResult[]>> {
  if (!query.trim()) {
    return { success: true, data: [] };
  }
  try {
    const results = await searchPiPackages(query);
    return { success: true, data: results };
  } catch {
    return { success: true, data: [] };
  }
}