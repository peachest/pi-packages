import { createI18nBridge } from "pi-i18n-utils";

export const I18N_NAMESPACE = "pi-proxy";

const _bridge = createI18nBridge({ namespace: I18N_NAMESPACE });
export const t = (key: string, fallback: string) => _bridge.t(key, fallback);
