/* ------------------------------------------------------------------ */
/*  Render utilities tests                                            */
/*                                                                     */
/*  Tests frame(), pad(), divider(), selectedLine(), isPlainSearchInput(),
 *  footerHint()                                                       */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi } from "vitest";

vi.mock("../state/i18n-bridge.ts", () => ({
  t: (_key: string, fallback: string) => fallback,
  i18nAvailable: false,
  i18nInitDone: false,
  I18N_NAMESPACE: "pi-wishlist",
}));

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  frame, pad, divider, selectedLine, isPlainSearchInput,
  footerHint,
  type Theme,
} from "./render.ts";

function mockTheme(): Theme {
  return {
    fg: (_key: string, text: string) => text,
    bg: (_key: string, text: string) => text,
    inverse: (text: string) => text,
    bold: (text: string) => text,
  } as Theme;
}

describe("pad", () => {
  it("pads text to exact width", () => {
    expect(pad("hello", 10)).toBe("hello     ");
  });

  it("truncates text to visible width when exceeding", () => {
    const result = pad("hello world", 8);
    expect(visibleWidth(result)).toBe(8);
  });

  it("returns exact text when length equals width", () => {
    expect(pad("hello", 5)).toBe("hello");
  });

  it("handles empty string", () => {
    expect(pad("", 5)).toBe("     ");
  });
});

describe("frame", () => {
  it("wraps content in a bordered frame with title", () => {
    const lines = frame(["content line"], 40, mockTheme(), undefined, "Test Title");
    expect(lines[0]).toContain("Test Title");
    expect(lines[lines.length - 1]).toMatch(/^[└┗]/);
  });

  it("wraps content without title", () => {
    const lines = frame(["hello"], 30, mockTheme());
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toMatch(/^[┌┏]/);
    expect(lines[lines.length - 1]).toMatch(/^[└┗]/);
  });

  it("renders content lines between borders", () => {
    const lines = frame(["my content"], 40, mockTheme());
    const body = lines.join("\n");
    expect(body).toContain("my content");
  });

  it("adds padding rows above and below content", () => {
    const lines = frame(["only"], 30, mockTheme());
    expect(lines.length).toBe(5); // top, pad, content, pad, bottom
  });
});

describe("divider", () => {
  it("creates a horizontal line of given width", () => {
    const d = divider(20, mockTheme());
    expect(d.length).toBeGreaterThanOrEqual(20);
  });

  it("handles minimum width", () => {
    const d = divider(1, mockTheme());
    expect(d.length).toBeGreaterThanOrEqual(1);
  });
});

describe("selectedLine", () => {
  it("pads and marks a line as selected", () => {
    const line = selectedLine(mockTheme(), "hello", 10);
    expect(line).toContain("hello");
    expect(visibleWidth(line)).toBeGreaterThanOrEqual(10);
  });
});

describe("isPlainSearchInput", () => {
  it("accepts printable characters and returns the char", () => {
    expect(isPlainSearchInput("a")).toBe("a");
    expect(isPlainSearchInput("Z")).toBe("Z");
    expect(isPlainSearchInput(" ")).toBe(" ");
    expect(isPlainSearchInput("1")).toBe("1");
    expect(isPlainSearchInput("中")).toBe("中");
  });

  it("rejects control characters and returns null", () => {
    expect(isPlainSearchInput("\n")).toBeNull();
    expect(isPlainSearchInput("\r")).toBeNull();
    expect(isPlainSearchInput("\t")).toBeNull();
    expect(isPlainSearchInput("\x1b")).toBeNull();
  });

  it("rejects delete character and returns null", () => {
    expect(isPlainSearchInput("\x7f")).toBeNull();
  });

  it("rejects multi-character strings and returns null", () => {
    expect(isPlainSearchInput("ab")).toBeNull();
    expect(isPlainSearchInput("")).toBeNull();
  });
});

describe("frame — snapshot", () => {
  it("matches snapshot for a typical frame with title", () => {
    const lines = frame(["Header line", "Content line A", "Content line B"], 50, mockTheme(), undefined, "Pi Wishlist");
    expect(lines.join("\n")).toMatchSnapshot();
  });

  it("matches snapshot with truncated overflow", () => {
    const lines = frame(["line 1", "line 2", "line 3", "line 4", "line 5"], 50, mockTheme(), 3, "Truncated");
    expect(lines.join("\n")).toMatchSnapshot();
  });
});

describe("footerHint", () => {
  it("returns list mode hint", () => {
    const hint = footerHint("list" as WishlistMode);
    expect(hint).toContain("a");
    expect(hint).toContain("d");
    expect(hint).toContain("/");
    expect(hint).toContain("q");
  });

  it("returns search mode hint", () => {
    const hint = footerHint("search" as WishlistMode);
    expect(hint).toContain("Esc");
    expect(hint).toContain("confirm");
    expect(hint).toContain("Backspace");
  });

  it("returns edit-note mode hint", () => {
    const hint = footerHint("edit-note" as WishlistMode);
    expect(hint).toContain("Enter");
    expect(hint).toContain("cancel");
    expect(hint).toContain("←/→");
  });

  it("returns remove-confirm mode hint", () => {
    const hint = footerHint("remove-confirm" as WishlistMode);
    expect(hint).toContain("y");
    expect(hint).toContain("confirm");
  });

  it("returns add-search mode hint", () => {
    const hint = footerHint("add-search" as WishlistMode);
    expect(hint).toContain("↑↓");
    expect(hint).toContain("select");
    expect(hint).toContain("back");
  });

  it("returns add-note mode hint", () => {
    const hint = footerHint("add-note" as WishlistMode);
    expect(hint).toContain("Enter");
    expect(hint).toContain("cancel");
  });

});