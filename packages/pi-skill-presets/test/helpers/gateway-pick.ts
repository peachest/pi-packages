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
 * Preference (ocr R4M1): among providers with a valid http(s) baseUrl, the
 * one hosting `pinnedModelId`, else the first valid provider. Returns
 * undefined when no provider with a usable baseUrl exists.
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
  // URL-validity first (ocr R4M1): a hosting provider with an unusable
  // baseUrl must not shadow a valid fallback — filter to providers that can
  // actually be dialed, then apply the hosting-first preference in that set.
  const hasValidUrl = (
    p: Record<string, unknown>,
  ): p is Record<string, unknown> & { baseUrl: string } =>
    isValidHttpUrl(p.baseUrl);
  const valid = usable.filter(hasValidUrl);
  const hosting = valid.find((p) => {
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
  const picked = hosting ?? valid[0];
  if (!picked) return undefined;
  const apiKey = picked.apiKey;
  return { baseUrl: picked.baseUrl, ...(typeof apiKey === "string" ? { apiKey } : {}) };
}

// Strict http(s) check (ocr R1): startsWith("http") accepts junk like
// "httpx://bad"; parse and pin the protocol instead.
function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
