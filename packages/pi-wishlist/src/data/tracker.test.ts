/* ------------------------------------------------------------------ */
/*  Pi Wishlist — tracker tests (fetch-based)                         */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
});

describe("fetchNpmData", () => {
  it("returns NpmSource on successful registry + downloads fetch", async () => {
    let fetchCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      fetchCount++;
      if (url.includes("registry.npmjs.org")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "4.17.21", repository: { url: "git+https://github.com/lodash/lodash.git" } }),
        });
      }
      if (url.includes("api.npmjs.org/downloads")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ downloads: 28918472 }),
        });
      }
      return Promise.resolve({ ok: false });
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchNpmData } = await import("./tracker.ts");
    const result = await fetchNpmData("lodash");

    expect(result).toEqual({
      latestVersion: "4.17.21",
      weeklyDownloads: 28918472,
      repositoryUrl: "git+https://github.com/lodash/lodash.git",
    });
    expect(fetchCount).toBe(2); // registry + downloads
    vi.unstubAllGlobals();
  });

  it("returns undefined on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const { fetchNpmData } = await import("./tracker.ts");
    expect(await fetchNpmData("lodash")).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("returns undefined for unsafe package names", async () => {
    const { fetchNpmData } = await import("./tracker.ts");
    expect(await fetchNpmData("../../../etc/passwd")).toBeUndefined();
  });
});

describe("fetchNpmData repositoryUrl", () => {
  it("includes repositoryUrl from registry metadata", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: "1.0.0", repository: { url: "git+https://github.com/lodash/lodash.git" } }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const { fetchNpmData } = await import("./tracker.ts");
    const result = await fetchNpmData("lodash");
    expect(result?.repositoryUrl).toBe("git+https://github.com/lodash/lodash.git");
    vi.unstubAllGlobals();
  });

  it("omits repositoryUrl when registry lacks repository field", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: "1.0.0" }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const { fetchNpmData } = await import("./tracker.ts");
    const result = await fetchNpmData("lodash");
    expect(result?.repositoryUrl).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("fetchGithubData", () => {
  it("returns parsed GitHub data on successful fetch", async () => {
    const mockJson = {
      stargazers_count: 60000,
      forks_count: 15000,
      open_issues_count: 200,
      pushed_at: "2025-06-01T00:00:00Z",
    };
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockJson),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchGithubData } = await import("./tracker.ts");
    const result = await fetchGithubData("lodash", "lodash");
    expect(result).toEqual({
      owner: "lodash",
      repo: "lodash",
      stars: 60000,
      forks: 15000,
      openIssues: 200,
      pushedAt: "2025-06-01T00:00:00Z",
    });
    vi.unstubAllGlobals();
  });

  it("returns undefined on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchGithubData } = await import("./tracker.ts");
    expect(await fetchGithubData("lodash", "lodash")).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("returns undefined on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", mockFetch);

    const { fetchGithubData } = await import("./tracker.ts");
    expect(await fetchGithubData("lodash", "lodash")).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("includes Authorization header when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_test123";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        stargazers_count: 100,
        forks_count: 10,
        open_issues_count: 1,
        pushed_at: "2025-06-01T00:00:00Z",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchGithubData } = await import("./tracker.ts");
    await fetchGithubData("lodash", "lodash");

    const fetchUrl = mockFetch.mock.calls[0][0];
    const fetchOpts = mockFetch.mock.calls[0][1];
    expect(fetchUrl).toBe("https://api.github.com/repos/lodash/lodash");
    expect(fetchOpts.headers.Authorization).toBe("Bearer ghp_test123");

    delete process.env.GITHUB_TOKEN;
    vi.unstubAllGlobals();
  });

  it("does not send Authorization header when GITHUB_TOKEN is absent", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        stargazers_count: 100,
        forks_count: 10,
        open_issues_count: 1,
        pushed_at: "2025-06-01T00:00:00Z",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { fetchGithubData } = await import("./tracker.ts");
    await fetchGithubData("lodash", "lodash");

    const fetchOpts = mockFetch.mock.calls[0][1];
    expect(fetchOpts.headers.Authorization).toBeUndefined();

    vi.unstubAllGlobals();
  });
});

describe("trackPackage", () => {
  it("fetches npm + github data without duplicate API calls", async () => {
    let githubFetchCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("registry")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "1.0.0", repository: { url: "git+https://github.com/owner/repo.git" } }),
        });
      }
      if (url.includes("downloads")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ downloads: 5000 }),
        });
      }
      if (url.includes("api.github.com")) {
        githubFetchCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            stargazers_count: 100,
            forks_count: 10,
            open_issues_count: 1,
            pushed_at: "2025-01-01T00:00:00Z",
          }),
        });
      }
      return Promise.resolve({ ok: false });
    });
    vi.stubGlobal("fetch", mockFetch);

    const { trackPackage } = await import("./tracker.ts");
    const result = await trackPackage("my-pkg");

    expect(result.npm?.latestVersion).toBe("1.0.0");
    expect(result.npm?.weeklyDownloads).toBe(5000);
    expect(result.github?.stars).toBe(100);
    expect(githubFetchCount).toBe(1);
    vi.unstubAllGlobals();
  });

  it("handles non-GitHub repo without crashing", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("registry")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: "1.0.0", repository: { url: "git+https://gitlab.com/owner/repo.git" } }),
        });
      }
      if (url.includes("downloads")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ downloads: 5000 }),
        });
      }
      return Promise.resolve({ ok: false });
    });
    vi.stubGlobal("fetch", mockFetch);

    const { trackPackage } = await import("./tracker.ts");
    const result = await trackPackage("my-pkg");

    expect(result.npm?.latestVersion).toBe("1.0.0");
    expect(result.github).toBeUndefined();
    expect(result.errors).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe("throttle (rate-limit delay)", () => {
  it("ensures at least 200ms between API calls", async () => {
    const { withThrottle } = await import("./tracker.ts");
    const timestamps: number[] = [];
    const fn = async () => { timestamps.push(Date.now()); };
    await withThrottle(fn);
    await withThrottle(fn);
    expect(timestamps).toHaveLength(2);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(190);
  });
});