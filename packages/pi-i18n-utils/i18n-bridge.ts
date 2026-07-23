/* ------------------------------------------------------------------ */
/*  shared i18n bridge — factory for @juicesharp/rpiv-i18n             */
/*                                                                     */
/*  Usage:                                                             */
/*    import { createI18nBridge } from "pi-i18n-utils";                */
/*    export const I18N_NAMESPACE = "my-package";                      */
/*    const _b = createI18nBridge({ namespace: I18N_NAMESPACE, ... }); */
/*    export const t = (k: string, f: string) => _b.t(k, f);          */
/*    export const bridge = _b; // for i18nAvailable etc.             */
/*                                                                     */
/*  When SDK is absent, t() returns fallback (English) verbatim.       */
/* ------------------------------------------------------------------ */

export type TranslateFn = (key: string, fallback: string) => string;

export interface I18nBridgeConfig {
  namespace: string;
  /** Absolute URL to locales/ dir for auto-registration. Omit to skip. */
  localesDir?: string;
  /** Label for registerLocalesFromDir. Defaults to namespace. */
  label?: string;
  /** Optional debug logger. */
  debug?: (...args: unknown[]) => void;
}

export interface I18nBridge {
  t(key: string, fallback: string): string;
  readonly i18nAvailable: boolean;
  readonly i18nInitDone: boolean;
  readonly initPromise: Promise<void>;
}

export function createI18nBridge(config: I18nBridgeConfig): I18nBridge {
  const { namespace, localesDir, label, debug } = config;
  const _debug = debug ?? (() => {});

  let tFn: TranslateFn = (_, fallback) => fallback;
  let _available = false;
  let _done = false;

  const init = (async () => {
    try {
      const [sdk, loaderModule] = await Promise.all([
        import("@juicesharp/rpiv-i18n"),
        localesDir ? import("@juicesharp/rpiv-i18n/loader") : null,
      ]);

      if (localesDir && loaderModule) {
        loaderModule.registerLocalesFromDir(namespace, localesDir, {
          label: label ?? namespace,
        });
      }

      tFn = sdk.scope(namespace);
      _available = true;
      _debug("i18n init OK", { namespace, hasLocales: !!localesDir });
    } catch (err) {
      _debug("i18n init failed", err instanceof Error ? err.message : err);
    } finally {
      _done = true;
    }
  })();

  return {
    t(key, fallback) { return tFn(key, fallback); },
    get i18nAvailable() { return _available; },
    get i18nInitDone() { return _done; },
    initPromise: init,
  };
}
