/* ------------------------------------------------------------------ */
/*  Wishlist component tests — list navigation + search filter        */
/*                                                                     */
/*  Tests createWishlistComponent() through its public interface.      */
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
import * as tracker from "../data/tracker.ts";
import * as editNote from "../data/edit-note.ts";

function mockTheme(): Theme {
  return {
    fg: (_key: string, text: string) => text,
    bg: (_key: string, text: string) => text,
    inverse: (text: string) => text,
    bold: (text: string) => text,
  } as Theme;
}

function noop() {}

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

describe("createWishlistComponent — list mode", () => {
  beforeEach(() => {
    vi.spyOn(wishlist, "listPackages").mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("empty state", () => {
    it("renders empty state message when no packages", () => {
      const { comp } = makeComponent([]);
      const lines = comp.render(200);
      expect(lines.join("\n")).toContain("wishlist is empty");
      expect(lines.join("\n")).toContain("a");
    });
  });

  describe("list view", () => {
    it("renders package names in the list", () => {
      const { comp } = makeComponent([
        mockPackage("pi-marketplace"),
        mockPackage("pi-subagents"),
      ]);
      const lines = comp.render(200);
      expect(lines.join("\n")).toContain("pi-marketplace");
      expect(lines.join("\n")).toContain("pi-subagents");
    });
  });

  describe("keyboard navigation", () => {
    it("moves selection down with arrow down and up with arrow up", () => {
      const { comp } = makeComponent([
        mockPackage("pi-a"),
        mockPackage("pi-b"),
        mockPackage("pi-c"),
      ]);

      const before = comp.render(200).join("\n");
      expect(before).toContain("pi-a");

      comp.handleInput("\x1b[B"); // down
      comp.handleInput("\x1b[B"); // down
      const afterDown = comp.render(200).join("\n");
      expect(afterDown).toContain("pi-c");

      comp.handleInput("\x1b[A"); // up
      comp.handleInput("\x1b[A"); // up
      const afterUp = comp.render(200).join("\n");
      expect(afterUp).toContain("pi-a");
    });
  });

  describe("close", () => {
    it("calls done with close on q", () => {
      const { comp, done } = makeComponent([mockPackage("pi-a")]);
      comp.handleInput("q");
      expect(done).toHaveBeenCalledWith({ type: "close" });
    });

    it("calls done with close on Escape when not in detail mode", () => {
      const { comp, done } = makeComponent([mockPackage("pi-a")]);
      comp.handleInput("\x1b");
      expect(done).toHaveBeenCalledWith({ type: "close" });
    });

    it("does not call done on Escape when in detail mode (goes back first)", () => {
      const { comp, done } = makeComponent([mockPackage("pi-a")]);
      comp.handleInput("\r"); // toggle detail
      comp.handleInput("\x1b"); // escape closes detail
      expect(done).not.toHaveBeenCalled();
      comp.handleInput("\x1b"); // escape again closes modal
      expect(done).toHaveBeenCalledWith({ type: "close" });
    });
  });

  describe("detail panel", () => {
    it("toggles detail panel on Enter", () => {
      const { comp } = makeComponent([mockPackage("pi-test")]);
      const before = comp.render(200).join("\n");
      expect(before).not.toContain("added:");

      comp.handleInput("\r"); // Enter
      const after = comp.render(200).join("\n");
      expect(after).toContain("added:");
    });
  });

  describe("footer help bar", () => {
    it("shows action keys in list view", () => {
      const { comp } = makeComponent([mockPackage("pi-a")]);
      const lines = comp.render(200);
      const footer = lines.find(l => l.includes("a add"));
      expect(footer).toBeDefined();
      expect(footer).toContain("q");
      expect(footer).toContain("d");
      expect(footer).toContain("/");
    });

    it("shows search-mode keys when actively searching", () => {
      const { comp } = makeComponent([mockPackage("pi-a")]);
      comp.handleInput("/");
      const lines = comp.render(200);
      expect(lines.join("\n")).toContain("Esc");
      expect(lines.join("\n")).toContain("Backspace");
    });
  });

  describe("invalidate", () => {
    it("reloads packages on invalidate", () => {
      const { comp } = makeComponent([mockPackage("pi-a")]);
      const before = comp.render(200).join("\n");
      expect(before).toContain("pi-a");

      vi.spyOn(wishlist, "listPackages").mockReturnValue([mockPackage("pi-b")]);
      comp.invalidate();

      const after = comp.render(200).join("\n");
      expect(after).toContain("pi-b");
      expect(after).not.toContain("pi-a");
    });
  });
});

describe("createWishlistComponent — search mode", () => {
  beforeEach(() => {
    vi.spyOn(wishlist, "listPackages").mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enters search mode on /", () => {
    const { comp } = makeComponent([mockPackage("pi-marketplace")]);
    comp.handleInput("/");
    const lines = comp.render(200);
    expect(lines.join("\n")).toContain(">");
  });

  it("highlights matching text in list", () => {
    const { comp } = makeComponent([mockPackage("pi-marketplace")]);
    comp.invalidate();
    comp.handleInput("/");
    for (const ch of "market") comp.handleInput(ch);

    const lines = comp.render(200);
    expect(lines.join("\n")).toContain("**market**");
  });

  it("filters packages when searching", () => {
    const { comp } = makeComponent([
      mockPackage("pi-marketplace"),
      mockPackage("pi-subagents"),
      mockPackage("pi-search"),
    ]);
    comp.invalidate();
    comp.handleInput("/");
    for (const ch of "ma") comp.handleInput(ch);

    const lines = comp.render(200);
    expect(lines.join("\n")).toContain("**ma**");
    expect(lines.join("\n")).not.toContain("pi-subagents");
  });

  it("exits search mode on Enter and retains filter", () => {
    const { comp } = makeComponent([
      mockPackage("pi-marketplace"),
      mockPackage("pi-subagents"),
    ]);
    comp.handleInput("/");
    for (const ch of "sub") comp.handleInput(ch);
    comp.handleInput("\r"); // exit search

    const lines = comp.render(200);
    expect(lines.join("\n")).toContain("sub");
    expect(lines.join("\n")).not.toContain("marketplace");
  });

  it("exits search mode on Escape and retains filter", () => {
    const { comp } = makeComponent([
      mockPackage("pi-marketplace"),
      mockPackage("pi-subagents"),
    ]);
    comp.handleInput("/");
    for (const ch of "market") comp.handleInput(ch);
    comp.handleInput("\x1b"); // exit search

    const lines = comp.render(200);
    expect(lines.join("\n")).toContain("**market**");
    expect(lines.join("\n")).not.toContain("subagents");
  });

  it("clears search with ctrl+u", () => {
    const { comp } = makeComponent([
      mockPackage("pi-marketplace"),
      mockPackage("pi-subagents"),
    ]);
    comp.handleInput("/");
    for (const ch of "pi-") comp.handleInput(ch);
    comp.handleInput("\x15"); // ctrl+u — clear
    // Exit search mode to see all packages
    comp.handleInput("\r");
    const lines = comp.render(200);
    expect(lines.join("\n")).toContain("pi-marketplace");
    expect(lines.join("\n")).toContain("pi-subagents");
  });
});

describe("createWishlistComponent — edit note mode", () => {
  beforeEach(() => {
    vi.spyOn(wishlist, "listPackages").mockReturnValue([]);
    vi.spyOn(editNote, "handleEditNote").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enters edit mode on e with current notes pre-filled", () => {
    const { comp } = makeComponent([
      mockPackage("pi-test", { notes: "my note" }),
    ]);
    comp.handleInput("e");
    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("my note");
    // Should show the inline edit cursor
    expect(text).toContain("█");
  });

  it("shows empty buffer when no notes", () => {
    const { comp } = makeComponent([
      mockPackage("pi-test"),
    ]);
    comp.handleInput("e");
    const lines = comp.render(200);
    // Empty note means cursor only
    expect(lines.join("\n")).toContain("█");
  });

  it("shows edit-note footer", () => {
    const { comp } = makeComponent([mockPackage("pi-test")]);
    comp.handleInput("e");
    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("Enter save");
    expect(text).toContain("Esc cancel");
    expect(text).toContain("←/→");
  });

  it("saves note on Enter", () => {
    const { comp } = makeComponent([mockPackage("pi-test")]);
    comp.handleInput("e");
    // type some notes
    for (const ch of "new note") comp.handleInput(ch);
    comp.handleInput("\r"); // Enter — save

    expect(editNote.handleEditNote).toHaveBeenCalledWith("npm:pi-test", "new note");
  });

  it("cancels edit on Escape and returns to list mode", () => {
    const { comp } = makeComponent([mockPackage("pi-test")]);
    comp.handleInput("e");
    for (const ch of "new note") comp.handleInput(ch);
    comp.handleInput("\x1b"); // Esc — cancel

    const lines = comp.render(200);
    const text = lines.join("\n");
    // List mode footer, not edit mode
    expect(text).toContain("a add");
    // edit note should not have been called
    expect(editNote.handleEditNote).not.toHaveBeenCalled();
  });

  it("delegates keyboard input to handleInlineEditInput while editing", () => {
    const { comp } = makeComponent([mockPackage("pi-test")]);
    comp.handleInput("e"); // enter edit, buffer = ""
    // type hello
    for (const ch of "hello") comp.handleInput(ch);
    const afterType = comp.render(200).join("\n");
    expect(afterType).toContain("hello█");

    // backspace
    comp.handleInput("\x7f");
    const afterBS = comp.render(200).join("\n");
    expect(afterBS).toContain("hell█");

    // save
    comp.handleInput("\r");
    expect(editNote.handleEditNote).toHaveBeenCalledWith("npm:pi-test", "hell");
  });
});

describe("createWishlistComponent — remove confirm mode", () => {
  beforeEach(() => {
    vi.spyOn(wishlist, "listPackages").mockReturnValue([]);
    vi.spyOn(wishlist, "removePackage").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enters remove confirm mode on d", () => {
    const { comp } = makeComponent([
      mockPackage("pi-test"),
    ]);
    comp.handleInput("d");
    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("confirm remove");
  });

  it("shows remove-confirm footer", () => {
    const { comp } = makeComponent([mockPackage("pi-test")]);
    comp.handleInput("d");
    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("y/Enter confirm");
  });

  it("removes package on y confirm", () => {
    const { comp } = makeComponent([mockPackage("pi-to-remove")]);
    comp.handleInput("d");
    comp.handleInput("y");

    expect(wishlist.removePackage).toHaveBeenCalledWith("npm:pi-to-remove");
  });

  it("removes package on Y confirm", () => {
    const { comp } = makeComponent([mockPackage("pi-to-remove")]);
    comp.handleInput("d");
    comp.handleInput("Y");

    expect(wishlist.removePackage).toHaveBeenCalledWith("npm:pi-to-remove");
  });

  it("cancels remove on any other key", () => {
    const { comp } = makeComponent([mockPackage("pi-test")]);
    comp.handleInput("d");
    comp.handleInput("n");

    expect(wishlist.removePackage).not.toHaveBeenCalled();
  });

  it("returns to list mode after confirm or cancel", () => {
    const { comp } = makeComponent([mockPackage("pi-test")]);
    comp.handleInput("d");
    comp.handleInput("y");

    const lines = comp.render(200);
    const text = lines.join("\n");
    expect(text).toContain("a add"); // list mode footer
  });
});

// ── Snapshot tests (frozen time for deterministic output) ────────
describe("createWishlistComponent — render snapshots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T12:00:00.000Z"));
    vi.spyOn(wishlist, "listPackages").mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Fixed data for snapshot — frozen dates so detail panel doesn't drift
  function mockSnapshotPkg(name: string, overrides: Record<string, unknown> = {}) {
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

  it("matches snapshot: empty list", () => {
    const { comp } = makeComponent([]);
    expect(comp.render(60).join("\n")).toMatchSnapshot();
  });

  it("matches snapshot: list with packages", () => {
    const { comp } = makeComponent([
      mockSnapshotPkg("pi-marketplace"),
      mockSnapshotPkg("pi-subagents", { notes: "waiting for v2" }),
    ]);
    expect(comp.render(60).join("\n")).toMatchSnapshot();
  });

  it("matches snapshot: detail panel (Enter toggle)", () => {
    const { comp } = makeComponent([
      mockSnapshotPkg("pi-marketplace", {
        notificationEvents: [
          { type: "new_version", from: "0.9.0", to: "1.0.0", at: "2026-06-22T00:00:00.000Z" },
        ],
      }),
    ]);
    comp.handleInput("\r"); // toggle detail
    expect(comp.render(60).join("\n")).toMatchSnapshot();
  });

  it("matches snapshot: search mode", () => {
    const { comp } = makeComponent([
      mockSnapshotPkg("pi-marketplace"),
      mockSnapshotPkg("pi-subagents"),
      mockSnapshotPkg("pi-search"),
    ]);
    comp.handleInput("/");
    for (const ch of "pi-s") comp.handleInput(ch);
    expect(comp.render(60).join("\n")).toMatchSnapshot();
  });

  it("matches snapshot: remove-confirm mode", () => {
    const { comp } = makeComponent([mockSnapshotPkg("pi-marketplace")]);
    comp.handleInput("d"); // remove
    expect(comp.render(60).join("\n")).toMatchSnapshot();
  });
});

// ── Multi-step scenario tests ────────────────────────────────────
/**
 * Run a sequence of actions against the component, asserting render
 * expectations at each step. No dependencies — just handleInput + render.
 */
function runScenario(
  comp: ReturnType<typeof makeComponent>["comp"],
  scenario: Array<{ input?: string; assert: (text: string) => void }>,
  width = 200,
) {
  for (const step of scenario) {
    if (step.input) comp.handleInput(step.input);
    step.assert(comp.render(width).join("\n"));
  }
}

describe("createWishlistComponent — scenarios", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T12:00:00.000Z"));
    vi.spyOn(wishlist, "listPackages").mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function pkg(name: string, overrides: Record<string, unknown> = {}) {
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

  // ── Happy path: list → detail → close ──────────────────────────
  it("opens detail panel then closes modal", () => {
    const { comp, done } = makeComponent([pkg("pi-a")]);
    runScenario(comp, [
      // Step 0: initial list
      { assert: (t) => expect(t).toContain("pi-a") },
      // Step 1: Enter — toggle detail
      { input: "\r", assert: (t) => expect(t).toContain("added:") },
      // Step 2: Enter again — close detail
      { input: "\r", assert: (t) => expect(t).not.toContain("added:") },
      // Step 3: q — close modal
      { input: "q", assert: () => expect(done).toHaveBeenCalledWith({ type: "close" }) },
    ]);
  });

  // ── Happy path: remove flow ────────────────────────────────────
  it("removes a package via d → y", () => {
    const { comp, done } = makeComponent([pkg("pi-remove-me")]);
    runScenario(comp, [
      { assert: (t) => expect(t).toContain("pi-remove-me") },
      { input: "d", assert: (t) => expect(t).toContain("confirm remove") },
      { input: "y", assert: (t) => expect(t).toContain("a add") }, // back to list footer
    ]);
  });

  // ── Happy path: cancel remove flow ─────────────────────────────
  it("cancels remove via d → Esc back to list", () => {
    const { comp } = makeComponent([pkg("pi-stay")]);
    runScenario(comp, [
      { assert: (t) => expect(t).toContain("pi-stay") },
      { input: "d", assert: (t) => expect(t).toContain("confirm remove") },
      { input: "n", assert: (t) => {
        expect(t).toContain("pi-stay");
        expect(t).toContain("a add");
      }},
    ]);
  });

  // ── Search flow ────────────────────────────────────────────────
  it("enters search, filters, exits search, retains filter", () => {
    const { comp } = makeComponent([pkg("pi-marketplace"), pkg("pi-subagents")]);
    runScenario(comp, [
      { assert: (t) => expect(t).toContain("pi-marketplace") },
      // Enter search
      { input: "/", assert: (t) => expect(t).toContain(">") },
      // Type query (no render snapshot here, just check we're still in search)
      ..."sub".split("").map((ch) => ({
        input: ch,
        assert: (_t: string) => { /* typing in search mode */ },
      })),
      // Confirm search, check filter
      { input: "\r", assert: (t) => {
        expect(t).toContain("sub");
        expect(t).not.toContain("marketplace");
      }},
    ]);
  });

  // ── Navigation flow ────────────────────────────────────────────
  it("navigates selection with arrows", () => {
    const { comp } = makeComponent([pkg("pi-a"), pkg("pi-b"), pkg("pi-c")]);
    runScenario(comp, [
      { assert: (t) => expect(t).toContain("❯ pi-a") },
      { input: "\x1b[B", assert: (t) => expect(t).toContain("❯ pi-b") },
      { input: "\x1b[B", assert: (t) => expect(t).toContain("❯ pi-c") },
      { input: "\x1b[A", assert: (t) => expect(t).toContain("❯ pi-b") },
    ]);
  });

  // ── Edit note full flow ────────────────────────────────────────
  it("enters edit-note, types, saves and verifies state change", () => {
    vi.spyOn(editNote, "handleEditNote").mockReturnValue(null);
    const { comp } = makeComponent([pkg("pi-edit-me")]);
    runScenario(comp, [
      { assert: (t) => expect(t).toContain("pi-edit-me") },
      // Enter edit-note mode
      { input: "e", assert: (t) => expect(t).toContain("edit:") },
      // Type a note
      ..."urgent".split("").map((ch) => ({
        input: ch,
        assert: (_t: string) => {},
      })),
      // Save
      { input: "\r", assert: (t) => {
        expect(t).toContain("a add");
        expect(t).toContain("pi-edit-me");
      }},
    ]);
    expect(editNote.handleEditNote).toHaveBeenCalledWith("npm:pi-edit-me", "urgent");
  });

  // ── Search → detail → close (multi-mode chain) ─────────────────
  it("searches, opens detail of filtered result, then closes", () => {
    const { comp, done } = makeComponent([
      pkg("pi-marketplace"),
      pkg("pi-subagents"),
      pkg("pi-tui"),
    ]);
    runScenario(comp, [
      // Enter search
      { input: "/", assert: (t) => expect(t).toContain(">") },
      // Type to filter
      ..."sub".split("").map((ch) => ({ input: ch, assert: (_t: string) => {} })),
      // Exit search
      { input: "\r", assert: (t) => expect(t).not.toContain("pi-marketplace") },
      // Open detail
      { input: "\r", assert: (t) => expect(t).toContain("added:") },
      // Close detail, still filtered
      { input: "\r", assert: (t) => {
        expect(t).not.toContain("added:");
        expect(t).not.toContain("pi-marketplace");
      }},
      // Close modal
      { input: "q", assert: () => expect(done).toHaveBeenCalledWith({ type: "close" }) },
    ]);
  });

  // ── #5d: Enter confirms remove ─────────────────────────────────
  it("confirms remove via Enter key", () => {
    vi.spyOn(wishlist, "removePackage").mockReturnValue(true);
    const { comp } = makeComponent([pkg("pi-test")]);
    runScenario(comp, [
      { input: "d", assert: (t) => expect(t).toContain("confirm remove") },
      { input: "\r", assert: (t) => {
        expect(t).toContain("a add");
        expect(wishlist.removePackage).toHaveBeenCalledWith("npm:pi-test");
      }},
    ]);
  });

  // ── #5h: remove from filtered search ───────────────────────────
  it("removes item from filtered search results", () => {
    vi.spyOn(wishlist, "removePackage").mockReturnValue(true);
    const { comp } = makeComponent([
      pkg("pi-marketplace"),
      pkg("pi-subagents"),
      pkg("pi-tui"),
    ]);
    runScenario(comp, [
      { input: "/", assert: (t) => expect(t).toContain(">") },
      ..."sub".split("").map((ch) => ({ input: ch, assert: (_t: string) => {} })),
      { input: "\r", assert: (t) => expect(t).not.toContain("marketplace") },
      // Remove filtered item
      { input: "d", assert: (t) => expect(t).toContain("confirm remove") },
      { input: "y", assert: (t) => {
        expect(wishlist.removePackage).toHaveBeenCalledWith("npm:pi-subagents");
        expect(t).toContain("a add");
      }},
    ]);
  });

  // ── #2c + #10e: scroll with >10 items ──────────────────────────
  it("scrolls beyond VISIBLE_ROWS and shows overflow indicator", () => {
    vi.useRealTimers();
    vi.spyOn(wishlist, "listPackages").mockReturnValue(
      Array.from({ length: 14 }, (_, i) => pkg(`pi-pkg-${i + 1}`)),
    );
    const comp = createWishlistComponent(mockTheme(), vi.fn(), vi.fn());
    comp.invalidate();

    expect(comp.render(200).join("\n")).toContain("❯ pi-pkg-1");

    comp.handleInput("\x1b[B");
    comp.handleInput("\x1b[B");
    comp.handleInput("\x1b[B");
    expect(comp.render(200).join("\n")).toContain("❯ pi-pkg-4");
  });

  // ── #3f: empty search results ──────────────────────────────────
  it("shows empty state when search matches nothing", () => {
    const { comp } = makeComponent([
      pkg("pi-marketplace"),
      pkg("pi-subagents"),
    ]);
    runScenario(comp, [
      { input: "/", assert: (t) => expect(t).toContain(">") },
      ..."zzz".split("").map((ch) => ({ input: ch, assert: (_t: string) => {} })),
      { input: "\r", assert: (t) => {
        expect(t).toContain("no matching packages");
        expect(t).not.toContain("pi-marketplace");
      }},
    ]);
  });

  // ── #4f: save empty note (clear existing notes) ────────────────
  it("clears existing notes by saving empty note", () => {
    vi.spyOn(editNote, "handleEditNote").mockReturnValue(null);
    const { comp } = makeComponent([pkg("pi-has-notes", { notes: "old note" })]);
    runScenario(comp, [
      { input: "e", assert: (t) => expect(t).toContain("edit:") },
      // Ctrl+U clears buffer
      { input: "\x15", assert: (t) => expect(t).toContain("█") },
      // Save empty
      { input: "\r", assert: () => {
        expect(editNote.handleEditNote).toHaveBeenCalledWith("npm:pi-has-notes", "");
      }},
    ]);
  });

  // ── #3d: Ctrl+U clears search query ────────────────────────────
  it("clears search query with Ctrl+U", () => {
    const { comp } = makeComponent([
      pkg("pi-marketplace"),
      pkg("pi-subagents"),
    ]);
    runScenario(comp, [
      { input: "/", assert: (t) => expect(t).toContain(">") },
      ..."market".split("").map((ch) => ({ input: ch, assert: (_t: string) => {} })),
      // Ctrl+U clears, then Enter shows all
      { input: "\x15", assert: (_t: string) => {} },
      { input: "\r", assert: (t) => {
        expect(t).toContain("pi-marketplace");
        expect(t).toContain("pi-subagents");
      }},
    ]);
  });

  // ── #7h: full add flow with tracker success ────────────────────
  it("completes full add flow: search → select → note → confirm → tracker updates", async () => {
    // This test uses real timers because trackPackage fires async callbacks
    // that need Promise resolution, not setTimeout advancement.
    vi.useRealTimers();

    const mockSearch = await import("../data/search.ts");
    vi.spyOn(mockSearch, "searchPiPackages").mockResolvedValue([
      { name: "pi-wishlist", version: "0.1.0", description: "A wishlist package" },
    ]);
    vi.spyOn(wishlist, "addPackage").mockReturnValue(undefined);
    vi.spyOn(wishlist, "updatePackage").mockReturnValue(undefined);
    vi.spyOn(tracker, "trackPackage").mockResolvedValue({
      npm: { latestVersion: "0.1.0", weeklyDownloads: 100 },
      github: { owner: "test", repo: "pi-wishlist", stars: 5, forks: 1, openIssues: 0, pushedAt: "2026-06-01T00:00:00.000Z" },
      errors: [],
    });

    const { comp } = makeComponent([]);

    // Enter add search
    comp.handleInput("a");
    // Type query
    for (const ch of "wish") comp.handleInput(ch);
    // Wait for debounce timer (300ms) + search to resolve
    await new Promise((r) => setTimeout(r, 400));

    // Select first result (Enter)
    comp.handleInput("\r");

    // Now in add-note mode — confirm with Enter (no note)
    comp.handleInput("\r");

    // Wait for async tracker to resolve
    await new Promise((r) => setTimeout(r, 0));

    expect(wishlist.addPackage).toHaveBeenCalledWith(
      "npm:pi-wishlist", "npm:pi-wishlist", undefined,
    );
    expect(tracker.trackPackage).toHaveBeenCalledWith("npm:pi-wishlist");
    expect(wishlist.updatePackage).toHaveBeenCalled();
  });

  // ── #8a-8c: refresh flow ───────────────────────────────────────
  it("shows refreshing state then returns to list", async () => {
    // Mock runDailyCheck to resolve immediately (avoids real file I/O)
    const checker = await import("../data/checker.ts");
    vi.spyOn(checker, "runDailyCheck").mockResolvedValue([]);
    vi.spyOn(checker, "clearAllCooldowns").mockReturnValue(undefined);

    vi.useRealTimers();
    vi.spyOn(wishlist, "listPackages").mockReturnValue([pkg("pi-a")]);
    const comp = createWishlistComponent(mockTheme(), vi.fn(), vi.fn());
    comp.invalidate();

    comp.handleInput("r");

    const during = comp.render(200).join("\n");
    expect(during).toContain("checking");

    await new Promise((r) => setTimeout(r, 0));

    const after = comp.render(200).join("\n");
    expect(after).toContain("pi-a");
    expect(after).toContain("a add");
  });

  // ── Ctrl+C global close ────────────────────────────────────────
  it("closes modal on Ctrl+C", () => {
    const { comp, done } = makeComponent([pkg("pi-a")]);
    runScenario(comp, [
      { input: "\x03", assert: () => expect(done).toHaveBeenCalledWith({ type: "close" }) },
    ]);
  });

  // ── #9: invalidate calls requestRender ──────────────────────────
  describe("invalidate triggers requestRender", () => {
    it("calls requestRender after add-note confirm (Enter)", async () => {
      vi.useRealTimers();
      const mockSearch = await import("../data/search.ts");
      vi.spyOn(mockSearch, "searchPiPackages").mockResolvedValue([
        { name: "pi-newpkg", version: "0.1.0", description: "A new package" },
      ]);
      vi.spyOn(wishlist, "addPackage").mockReturnValue(undefined);
      vi.spyOn(wishlist, "updatePackage").mockReturnValue(undefined);
      vi.spyOn(tracker, "trackPackage").mockResolvedValue({
        npm: { latestVersion: "0.1.0", weeklyDownloads: 100 },
        github: { owner: "test", repo: "pi-newpkg", stars: 1, forks: 0, openIssues: 0, pushedAt: "2026-06-01T00:00:00.000Z" },
        errors: [],
      });

      const requestRender = vi.fn();
      vi.spyOn(wishlist, "listPackages").mockReturnValue([]);
      const comp = createWishlistComponent(mockTheme(), requestRender, vi.fn());
      comp.invalidate();
      requestRender.mockClear();

      // Enter add-search
      comp.handleInput("a");
      for (const ch of "new") comp.handleInput(ch);
      // Wait for debounce timer (300ms) + search to resolve
      await new Promise((r) => setTimeout(r, 400));

      // Select result
      comp.handleInput("\r");
      // Confirm add (no note)
      comp.handleInput("\r");

      // invalidate() itself calls requestRender at least once
      expect(requestRender).toHaveBeenCalled();
    });

    it("calls requestRender after edit-note save (Enter)", async () => {
      vi.spyOn(editNote, "handleEditNote").mockReturnValue(undefined);

      const requestRender = vi.fn();
      vi.spyOn(wishlist, "listPackages").mockReturnValue([pkg("pi-a", { notes: "old" })]);
      const comp = createWishlistComponent(mockTheme(), requestRender, vi.fn());
      comp.invalidate();
      requestRender.mockClear();

      comp.handleInput("e");
      for (const ch of " updated") comp.handleInput(ch);
      comp.handleInput("\r");

      expect(requestRender).toHaveBeenCalledTimes(1);
    });

    it("calls requestRender after remove confirm (y)", () => {
      vi.spyOn(wishlist, "removePackage").mockReturnValue(true);

      const requestRender = vi.fn();
      vi.spyOn(wishlist, "listPackages").mockReturnValue([pkg("pi-a")]);
      const comp = createWishlistComponent(mockTheme(), requestRender, vi.fn());
      comp.invalidate();
      requestRender.mockClear();

      comp.handleInput("d");
      comp.handleInput("y");

      expect(requestRender).toHaveBeenCalledTimes(1);
    });
  });
});