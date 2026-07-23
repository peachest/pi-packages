import { createI18nBridge, type TranslateFn } from "pi-i18n-utils";
import { debugLog } from "../data/debug.ts";

export type { TranslateFn };

const _debug = (...args: unknown[]) => debugLog("i18n", ...args);

export const I18N_NAMESPACE = "pi-wishlist";

const _bridge = createI18nBridge({
  namespace: I18N_NAMESPACE,
  localesDir: new URL("../../", import.meta.url).href,
  label: "pi-wishlist",
  debug: _debug,
});

/** Translate — returns scoped string or fallback (English). */
export function t(key: string, fallback: string): string {
  const result = _bridge.t(key, fallback);
  _debug("t()", { key, fallback, result });
  return result;
}

/** Bridge object for live-status reads (i18nAvailable, etc.) */
export { _bridge as bridge };
