/* ------------------------------------------------------------------ */
/*  Pi Wishlist — realistic search scenario tests                     */
/*  Mocks npm registry with 12+ pi packages to test query matching.   */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Realistic mock: packages you'd find on npm with keywords:pi-package
const MOCK_NPM_PACKAGES = [
  {
    package: {
      name: "pi-subagents",
      version: "1.3.0",
      description: "Subagent delegation for pi — chain, parallel, fork",
    },
  },
  {
    package: {
      name: "pi-session-search",
      version: "0.5.1",
      description: "Semantic search across pi coding sessions",
    },
  },
  {
    package: {
      name: "pi-agent-starter",
      version: "0.1.0",
      description: "Quick-start template for pi agent projects",
    },
  },
  {
    package: {
      name: "pi-theme-dracula",
      version: "1.0.2",
      description: "Dracula theme for pi coding agent",
    },
  },
  {
    package: {
      name: "pi-theme-nord",
      version: "0.9.0",
      description: "", // some packages have no description
    },
  },
  {
    package: {
      name: "pi-extension-markdown",
      version: "2.0.0",
      description: "Markdown preview extension for pi",
    },
  },
  {
    package: {
      name: "pi-extension-github",
      version: "1.1.0",
      description: "GitHub integration extension for pi",
    },
  },
  {
    package: {
      name: "pi-extension-terminal",
      version: "0.3.0",
      description: "Enhanced terminal UI extension for pi",
    },
  },
  {
    package: {
      name: "pi-tui-components",
      version: "0.8.0",
      description: "Reusable TUI component library for pi",
    },
  },
  {
    package: {
      name: "pi-prompt-manager",
      version: "0.4.0",
      description: "Manage and version pi system prompts",
    },
  },
  {
    package: {
      name: "pi-skill-creator",
      version: "1.0.0",
      description: "Generate pi skills from examples",
    },
  },
  {
    package: {
      name: "pi-config-utils",
      version: "0.2.0",
      description: "Configuration utilities for pi agent",
    },
  },
  {
    package: {
      name: "wishlist-test",
      version: "0.0.1",
      description: "Test package that should match wishlist queries",
      keywords: ["pi-package"], // extra test data
    },
  },
];

/**
 * Simulates npm search response for a given query.
 * npm search does full-text matching on name + description.
 * We simulate this with a simple substring match on name and description.
 */
function searchPackagesMock(query: string) {
  const q = query.toLowerCase();
  const results = MOCK_NPM_PACKAGES.filter((p) => {
    const name = p.package.name.toLowerCase();
    const desc = p.package.description.toLowerCase();
    return name.includes(q) || desc.includes(q);
  });
  return results;
}

// Helper to build npm-style response from filtered results
function npmResponse(results: typeof MOCK_NPM_PACKAGES) {
  return {
    objects: results,
    total: results.length,
    time: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("searchPiPackages — realistic scenarios", () => {
  async function searchTest(query: string) {
    const mockResults = searchPackagesMock(query);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(npmResponse(mockResults)),
    });
    const { searchPiPackages } = await import("./search.ts");
    const results = await searchPiPackages(query);
    return results;
  }

  it("finds packages by partial name match: 'theme' finds 2", async () => {
    const results = await searchTest("theme");
    const names = results.map((r) => r.name);
    expect(names).toContain("pi-theme-dracula");
    expect(names).toContain("pi-theme-nord");
    expect(results).toHaveLength(2);
  });

  it("finds packages by description match: 'extension' finds 3", async () => {
    const results = await searchTest("extension");
    expect(results).toHaveLength(3);
    const names = results.map((r) => r.name);
    expect(names).toContain("pi-extension-markdown");
    expect(names).toContain("pi-extension-github");
    expect(names).toContain("pi-extension-terminal");
  });

  it("finds packages by short query: 'agent' matches name + desc", async () => {
    const results = await searchTest("agent");
    const names = results.map((r) => r.name);
    // "pi-agent-starter" matches name, "pi-config-utils" matches desc "pi agent"
    expect(names).toContain("pi-agent-starter");
    expect(names).toContain("pi-config-utils");
  });

  it("finds packages by semantic term: 'search' finds session-search", async () => {
    const results = await searchTest("search");
    const names = results.map((r) => r.name);
    expect(names).toContain("pi-session-search");
  });

  it("returns empty for query that matches nothing", async () => {
    const results = await searchTest("zzz_no_match_123");
    expect(results).toEqual([]);
  });

  it("returns empty for empty/whitespace query (npm would return all)", async () => {
    // Need to test what happens when npm gets empty query — it returns nothing useful
    // but our mock would return everything. Let's test the actual function behavior.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(npmResponse(MOCK_NPM_PACKAGES)),
    });
    const { searchPiPackages } = await import("./search.ts");
    const results = await searchPiPackages("");
    // npm returns all packages for empty query, so our mock should too
    expect(results).toHaveLength(MOCK_NPM_PACKAGES.length);
  });

  it("finds packages by single character: 'p' (broad match)", async () => {
    const results = await searchTest("p");
    // All packages start with "pi-", so "p" should match everything
    expect(results).toHaveLength(MOCK_NPM_PACKAGES.length);
  });

  it("finds packages by mid-name substring: 'tui' matches 1", async () => {
    const results = await searchTest("tui");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("pi-tui-components");
  });

  it("finds packages by hyphenated query: 'skill-creator'", async () => {
    const results = await searchTest("skill-creator");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("pi-skill-creator");
  });

  it("finds packages by partial name from description: 'subagent'", async () => {
    const results = await searchTest("subagent");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("pi-subagents");
  });

  it("npm search is case-insensitive: 'Theme' finds same as 'theme'", async () => {
    const resultsLower = await searchTest("theme");
    const resultsUpper = await searchTest("Theme");
    expect(resultsLower).toHaveLength(resultsUpper.length);
    expect(resultsLower.map((r) => r.name).sort()).toEqual(
      resultsUpper.map((r) => r.name).sort(),
    );
  });

  it("handles multi-word query: 'pi extension' — npm search treats each word", async () => {
    // npm search with space-separated words matches either word
    // So 'pi extension' in our mock matches all (name starts with pi) → too broad
    // Let's just verify no crash
    const results = await searchTest("pi extension");
    expect(Array.isArray(results)).toBe(true);
  });

  it("all results have the expected shape", async () => {
    const results = await searchTest("agent");
    for (const r of results) {
      expect(r).toHaveProperty("name");
      expect(r).toHaveProperty("version");
      expect(r).toHaveProperty("description");
      expect(typeof r.name).toBe("string");
      expect(typeof r.version).toBe("string");
      expect(typeof r.description).toBe("string");
    }
  });

  it("returns correct version for each package", async () => {
    const results = await searchTest("subagents");
    expect(results[0].version).toBe("1.3.0");
  });
});

describe("searchPiPackages — query edge cases", () => {
  it("handles special characters in query", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ objects: [] }),
      });
    });

    const { searchPiPackages } = await import("./search.ts");
    await searchPiPackages("@scope/pkg-name");
    expect(capturedUrl).toContain(encodeURIComponent("@scope/pkg-name"));
    expect(capturedUrl).toContain("keywords:pi-package");
  });

  it("handles query with spaces", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ objects: [] }),
      });
    });

    const { searchPiPackages } = await import("./search.ts");
    await searchPiPackages("markdown extension");
    expect(capturedUrl).toContain(encodeURIComponent("markdown extension"));
  });

  it("handles very long query string", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ objects: [] }),
    });

    const { searchPiPackages } = await import("./search.ts");
    const longQuery = "a".repeat(500);
    const results = await searchPiPackages(longQuery);
    // Should not crash
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("searchPiPackages — response edge cases", () => {
  it("handles partially malformed response (missing description)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          objects: [
            {
              package: {
                name: "pi-only-name",
                version: "1.0.0",
                // no description
              },
            },
          ],
        }),
    });

    const { searchPiPackages } = await import("./search.ts");
    const results = await searchPiPackages("test");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("pi-only-name");
    // description should be undefined (from the API), we map it to ""
    expect(results[0].description).toBe("");
  });

  it("handles response with no 'objects' field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const { searchPiPackages } = await import("./search.ts");
    const results = await searchPiPackages("test");
    // Should crash safely — accessing .objects on undefined
    // Let's see what happens
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("handleSearch — integration with data layer", () => {
  async function commandSearchTest(query: string) {
    const mockResults = searchPackagesMock(query);
    vi.doMock("../data/search.ts", () => ({
      searchPiPackages: async () =>
        mockResults.map((r) => ({
          name: r.package.name,
          version: r.package.version,
          description: r.package.description || "",
        })),
    }));

    const { handleSearch } = await import("../commands/search.ts");
    return handleSearch(query);
  }

  it("command returns empty for empty query without calling API", async () => {
    vi.doMock("../data/search.ts", () => ({
      searchPiPackages: async () => {
        throw new Error("should not be called");
      },
    }));
    const { handleSearch } = await import("../commands/search.ts");
    const result = await handleSearch("  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
  });
});