/* ------------------------------------------------------------------ */
/*  Pi Wishlist — debug logging utility                               */
/*                                                                     */
/*  Usage: debugLog("checker", "fetch failed", err)                    */
/*  Output enabled via process.env.WISHLIST_DEBUG                      */
/*  Format: [wishlist:module] message                                  */
/* ------------------------------------------------------------------ */

const enabled = typeof process !== "undefined" && !!process.env.WISHLIST_DEBUG;

/**
 * Log a debug message if debug mode is enabled.
 * @param module Short module name like "tracker", "checker", "main"
 * @param message Primary message
 * @param args Optional additional values (JSON stringified)
 */
export function debugLog(module: string, message: string, ...args: unknown[]): void {
  if (!enabled) return;
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = `[${ts}][wishlist:${module}]`;
  if (args.length > 0) {
    console.error(prefix, message, ...args.map((a) => JSON.stringify(a)));
  } else {
    console.error(prefix, message);
  }
}