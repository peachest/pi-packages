/* ------------------------------------------------------------------ */
/*  Wishlist component tests — add-search and add-note flows          */
/*                                                                     */
/*  Tests the inline add-package flow inside createWishlistComponent  */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../state/i18n-bridge.ts", () => ({
  t: (_key: string, fallback: string) => fallback,
  i18nAvailable: false,
  i18nInitDone: false,
  I18N_NAMESPACE: "pi-wishlist",
}));

import { createWishlistComponent } from "./wishlist-view.ts";
import type { Theme } from "./render.ts";
import * as wishlist from "../data/wishlist.ts";
import * as search from "../data/search.ts";
import * as tracker from "../data/tracker.ts";

function mockTheme(): Theme {
  return {
    fg: (_key: string, text: string) => text,
    bg: (_key: string, text: string) => text,
    inverse: (text: string) => text,
    bold: (text: string) => text,
  } as Theme;
}

function mockPackage(name: string, overrides: Record<string, unknown> = {}) {
  return {
    key: `npm:${name}`,
    entry: {
      addedAt: "2026-01-01T00:00:00.000Z",
      notes: "",
      source: `npm:${name}`,
      sources: {
        npm: { latestVersion: "1.0.0", weeklyDownloads: 5000 },
        github: { owner: "test", repo: name, stars: 100, forks: 10, openIssues: 2, pushedAt: "2026-05-01T00:00:00.000Z" },
      },
      lastChecked: "2026-06-01T00:00:00.000Z",
      githubFailCount: 0,
      githubCooldownUntil: "",
      notificationEvents: [],
      ...overrides,
    },
  };
}

function makeComponent(pkgs: ReturnType<typeof mockPackage>[]) {
  vi.spyOn(wishlist, "listPackages").mockReturnValue(pkgs);
  const done = vi.fn();
  const requestRender = vi.fn();
  const comp = createWishlistComponent(mockTheme(), requestRender, done);
  comp.invalidate();
  return { comp, done, requestRender };
}

const mockResults = [
  { name: "pi-marketplace", version: "0.5.0", description: "A marketplace for pi extensions" },
  { name: "pi-subagents", version: "1.2.0", description: "Subagent delegation for pi" },
  { name: "pi-search", version: "0.3.0", description: "Search utility for pi packages" },
];

/** Flush pending microtasks so async search callbacks fire */
async function flushAsync() {
  await new Promise((r) => setTimeout(r, 0));
}

/** Enter add-search mode, type a query, and wait for debounce + search results */
async function enterSearch(
  comp: ReturnType<typeof makeComponent>["comp"],
  query: string,
) {
  comp.handleInput("a");
  for (const ch of query) comp.handleInput(ch);
  // Wait for debounce timer (300ms) + async fetch callback
  await new Promise((r) => setTimeout(r, 400));
  await flushAsync();
}

// ── Debounce & race-token tests ─────────────────────────────
describe("createWishlistComponent — add-search debounce + race token", () => {
  beforeEach(() => {
    vi.spyOn(wishlist, "listPackages").mockReturnValue([]);
    vi.spyOn(wishlist, "addPackage").mockReturnValue(undefined);
    vi.spyOn(tracker, "trackPackage").mockResolvedValue(undefined);
    vi.spyOn(search, "searchPiPackages").mockResolvedValue(mockResults);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("debounces rapid keystrokes: 'g','i','t' fires 1 call with 'git'", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    comp.handleInput("a"); // enter add-search

    comp.handleInput("g");
    comp.handleInput("i");
    comp.handleInput("t");

    // Debounce timer pending — should be 0 calls so far
    expect(search.searchPiPackages).not.toHaveBeenCalled();

    // Wait for debounce to fire naturally (300ms)
    await new Promise((r) => setTimeout(r, 400));

    expect(search.searchPiPackages).toHaveBeenCalledTimes(1);
    expect(search.searchPiPackages).toHaveBeenCalledWith("git");
  });

  it("fires separate calls when typing pauses between characters", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    comp.handleInput("a");

    comp.handleInput("g");
    comp.handleInput("i");
    // Pause longer than debounce
    await new Promise((r) => setTimeout(r, 400));

    comp.handleInput("t");
    await new Promise((r) => setTimeout(r, 400));

    // 2 separate calls: one for "gi", one for "git"
    expect(search.searchPiPackages).toHaveBeenCalledTimes(2);
    expect(search.searchPiPackages).toHaveBeenNthCalledWith(1, "gi");
    expect(search.searchPiPackages).toHaveBeenNthCalledWith(2, "git");
  });

  it("fires quickly for backspace (100ms debounce)", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    comp.handleInput("a");

    // Type "g" then "i" then backspace once
    comp.handleInput("g");
    await new Promise((r) => setTimeout(r, 400)); // let "g" debounce fire

    const beforeCalls = (search.searchPiPackages as any).mock.calls.length;

    comp.handleInput("i"); // query = "gi"
    comp.handleInput("\x7f"); // backspace → query = "g"

    // Wait less than 300ms (normal) but more than 100ms (backspace)
    await new Promise((r) => setTimeout(r, 150));

    const newCalls = (search.searchPiPackages as any).mock.calls.length - beforeCalls;
    expect(newCalls).toBe(1);
    expect(search.searchPiPackages).toHaveBeenLastCalledWith("g");
  });

  it("discards stale response from previous query (race token)", async () => {
    // Use a manual promise that we control
    let slowResolve!: (v: unknown) => void;
    const slowPromise = new Promise((r) => { slowResolve = r; });

    // Set up spy: first call returns slow promise, subsequent calls return mockResults
    const searchSpy = vi
      .spyOn(search, "searchPiPackages")
      .mockResolvedValueOnce(slowPromise as Promise<any>)
      .mockResolvedValue(mockResults);

    const { comp } = makeComponent([mockPackage("pi-a")]);
    comp.handleInput("a");

    comp.handleInput("g");
    // Wait for first debounce to fire
    await new Promise((r) => setTimeout(r, 400));

    // Now type more to cancel the first result
    comp.handleInput("i");
    comp.handleInput("t");
    await new Promise((r) => setTimeout(r, 400));

    // Resolve the slow promise now — this simulates network race
    slowResolve(mockResults);
    await new Promise((r) => setTimeout(r, 0));

    // The component should show "git" results, not "g" results
    const lines = comp.render(200).join("\n");
    expect(lines).toContain("pi-marketplace"); // from "git" search, which returned mockResults

    // searchPiPackages was called twice: "g" and "git"
    expect(searchSpy).toHaveBeenCalledTimes(2);
  });

  it("clears results immediately on empty query", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    comp.handleInput("a");
    comp.handleInput("g");
    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 400));
    vi.clearAllMocks();

    // Backspace to empty
    comp.handleInput("\x7f");

    // Results should be cleared immediately (no timer)
    const lines = comp.render(200).join("\n");
    // Should show placeholder, not results
    expect(lines).toContain("search for pi packages");
    // Should NOT have called searchPiPackages when clearing to empty
    expect(search.searchPiPackages).not.toHaveBeenCalled();
  });
});

describe("createWishlistComponent — add-search mode", () => {
  beforeEach(() => {
    vi.spyOn(wishlist, "listPackages").mockReturnValue([]);
    vi.spyOn(wishlist, "addPackage").mockReturnValue(undefined);
    vi.spyOn(tracker, "trackPackage").mockResolvedValue(undefined);
    vi.spyOn(search, "searchPiPackages").mockResolvedValue(mockResults);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enters add-search mode on a", () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    comp.handleInput("a");
    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain(">"); // search input line
    expect(text).toContain("↑↓"); // add-search footer
  });

  it("triggers npm search on text input", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    comp.handleInput("a");
    for (const ch of "market") comp.handleInput(ch);
    // Debounce timer fires after 300ms
    await new Promise((r) => setTimeout(r, 400));
    expect(search.searchPiPackages).toHaveBeenCalledWith("market");
  });

  it("renders search results after typing", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    await enterSearch(comp, "mar");

    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("pi-marketplace");
    expect(text).toContain("A marketplace");
  });

  it("navigates search results with arrow keys", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    await enterSearch(comp, "mar");

    // first result selected
    const before = comp.render(200).join("\n");
    expect(before).toContain("❯ pi-marketplace");

    comp.handleInput("\x1b[B"); // down
    const after = comp.render(200).join("\n");
    expect(after).toContain("❯ pi-subagents");
  });

  it("selects a result on Enter and enters add-note mode", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    await enterSearch(comp, "mar");
    comp.handleInput("\r"); // Enter selects first result

    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("Enter confirm");
    expect(text).toContain("Esc cancel");
  });

  it("returns to list mode on Escape", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    await enterSearch(comp, "mar");
    comp.handleInput("\x1b"); // Esc

    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("a add"); // list mode footer
  });

  it("shows add-search footer", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    await enterSearch(comp, "x"); // no results — still in add-search
    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("Esc back");
  });
});

describe("createWishlistComponent — add-note mode", () => {
  beforeEach(() => {
    vi.spyOn(wishlist, "listPackages").mockReturnValue([]);
    vi.spyOn(wishlist, "addPackage").mockReturnValue(undefined);
    vi.spyOn(tracker, "trackPackage").mockResolvedValue(undefined);
    vi.spyOn(search, "searchPiPackages").mockResolvedValue(mockResults);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Enter search, select result at index, wait for async */
  async function selectResult(
    comp: ReturnType<typeof makeComponent>["comp"],
    query: string,
    idx: number,
  ) {
    await enterSearch(comp, query);
    for (let i = 0; i < idx; i++) comp.handleInput("\x1b[B");
    comp.handleInput("\r");
  }

  it("starts with empty note buffer", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    await selectResult(comp, "pi", 0);

    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("█"); // cursor at start of empty buffer
  });

  it("accepts note text input", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    await selectResult(comp, "mar", 1); // select pi-subagents
    for (const ch of "wait for v2") comp.handleInput(ch);

    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("wait for v2█");
  });

  it("confirms add on Enter and calls addPackage + trackPackage", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    await selectResult(comp, "pi", 0); // select pi-marketplace
    for (const ch of "cool pkg") comp.handleInput(ch);
    comp.handleInput("\r"); // Enter to confirm

    expect(wishlist.addPackage).toHaveBeenCalledWith(
      "npm:pi-marketplace",
      "npm:pi-marketplace",
      "cool pkg",
    );
    expect(tracker.trackPackage).toHaveBeenCalledWith("npm:pi-marketplace");
  });

  it("returns to list mode after add", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    await selectResult(comp, "pi", 0);
    comp.handleInput("\r");

    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("a add"); // list mode footer
  });

  it("returns to list on Escape from add-note", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    await selectResult(comp, "pi", 0);
    comp.handleInput("\x1b"); // Esc back to list

    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("a add"); // list mode footer
  });

  it("shows add-note footer", async () => {
    const { comp } = makeComponent([mockPackage("pi-a")]);
    await selectResult(comp, "pi", 0);
    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("Enter confirm");
    expect(text).toContain("Esc cancel");
  });
});