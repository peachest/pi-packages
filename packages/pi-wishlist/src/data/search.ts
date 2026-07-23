/* ------------------------------------------------------------------ */
/*  Pi Wishlist — npm registry search (pi-package scoped)             */
/* ------------------------------------------------------------------ */

export interface SearchResult {
  name: string;
  version: string;
  description: string;
}

const NPM_SEARCH = "https://registry.npmjs.org/-/v1/search";

/**
 * Search npm registry for packages with keywords:pi-package.
 */
export async function searchPiPackages(query: string): Promise<SearchResult[]> {
  try {
    const url = `${NPM_SEARCH}?text=${encodeURIComponent(query)}+keywords:pi-package&size=20`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      objects: Array<{
        package: { name: string; version: string; description: string };
      }>;
    };
    return data.objects.map((o) => ({
      name: o.package.name,
      version: o.package.version,
      description: o.package.description || "",
    }));
  } catch {
    return [];
  }
}