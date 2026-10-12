/**
 * Pure gateway-pick logic extracted from preset-harness so it can be unit
 * tested without the harness module's side effects (gateway fetch,
 * ModelRuntime.create at import time).
 *
 * Structure defense (ocr N1): models.json may be parseable JSON yet have any
 * nested shape — this never throws, only returns undefined for unusable input.
 */

export interface GatewayInfo {
  baseUrl: string;
  apiKey?: string;
}

/**
 * Pick a gateway from a parsed models.json value.
 * Preference: the provider hosting `pinnedModelId`, else the first provider
 * with an http(s) baseUrl. Returns undefined when nothing usable exists.
 */
export function pickGatewayFromRaw(
  raw: unknown,
  pinnedModelId: string,
): GatewayInfo | undefined {
  const providersMap = (raw as { providers?: unknown } | null | undefined)?.providers;
  if (!providersMap || typeof providersMap !== "object" || Array.isArray(providersMap)) {
    return undefined;
  }
  // Validate each provider value individually: null, arrays and primitives
  // are all legal JSON shapes that must be skipped, not dereferenced.
  const providers: unknown[] = Object.values(providersMap as Record<string, unknown>);
  const usable = providers.filter(
    (p): p is Record<string, unknown> =>
      p !== null && typeof p === "object" && !Array.isArray(p),
  );
  const hosting = usable.find((p) => {
    const models = p.models;
    if (!Array.isArray(models)) return false;
    return models.some(
      (m) =>
        m !== null &&
        typeof m === "object" &&
        typeof (m as { id?: unknown }).id === "string" &&
        (m as { id: string }).id === pinnedModelId,
    );
  });
  // Hosting takes priority even when it lacks a usable baseUrl (original
  // semantics): a hosting pick without http baseUrl yields undefined.
  const picked = hosting ?? usable.find(httpProvider);
  if (!picked) return undefined;
  const baseUrl = picked.baseUrl;
  if (typeof baseUrl !== "string" || !baseUrl.startsWith("http")) return undefined;
  const apiKey = picked.apiKey;
  return { baseUrl, ...(typeof apiKey === "string" ? { apiKey } : {}) };
}

function httpProvider(p: Record<string, unknown>): boolean {
  return typeof p.baseUrl === "string" && p.baseUrl.startsWith("http");
}
