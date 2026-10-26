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
  /** Provider name (models.json providers-map key) this gateway was picked from (ocr R5M1). */
  provider: string;
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
  // are all legal JSON shapes that must be skipped, not dereferenced. Keep
  // the map key — it is the provider name consumers need to stay
  // provider-consistent (ocr R5M1).
  const usable = Object.entries(providersMap as Record<string, unknown>)
    .filter(
      (entry): entry is [string, Record<string, unknown>] =>
        entry[1] !== null &&
        typeof entry[1] === "object" &&
        !Array.isArray(entry[1]),
    );
  // URL-validity first (ocr R4M1): a hosting provider with an unusable
  // baseUrl must not shadow a valid fallback — filter to providers that can
  // actually be dialed, then apply the hosting-first preference in that set.
  const valid = usable.filter(
    (entry): entry is [string, Record<string, unknown> & { baseUrl: string }] =>
      isValidHttpUrl(entry[1].baseUrl),
  );
  const hosting = valid.find(([, p]) => {
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
  const [provider, p] = picked;
  const apiKey = p.apiKey;
  return {
    baseUrl: p.baseUrl,
    provider,
    ...(typeof apiKey === "string" ? { apiKey } : {}),
  };
}

/**
 * Strict provider-consistent model pick (ocr R6M3): only the pinned model
 * under `provider`. No cross-provider fallback — the reachability verdict
 * (`gatewayUp`) belongs to the probed provider, so a model resolved from a
 * different provider would run or skip the suite on the wrong probe. When
 * nothing matches, the caller skips the suite.
 */
export function pickPinnedModel<T extends { provider?: string; id: string }>(
  available: readonly T[],
  provider: string | undefined,
  pinnedModelId: string,
): T | undefined {
  if (provider === undefined) return undefined;
  return available.find((m) => m.provider === provider && m.id === pinnedModelId);
}

// Strict http(s) check (ocr R1): startsWith("http") accepts junk like
// "httpx://bad"; parse and pin the protocol instead. Credentials embedded
// in the URL (ocr R5M2) make fetch reject the request outright, so they
// count as unusable.
function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return false;
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
