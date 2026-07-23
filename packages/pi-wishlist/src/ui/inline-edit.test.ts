/* ------------------------------------------------------------------ */
/*  Inline edit utilities tests                                       */
/*                                                                     */
/*  Pure function tests — no imports of pi-tui or Theme needed.        */
/*  Tests only handleInlineEditInput() and renderInlineEditValue().    */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi } from "vitest";

vi.mock("../state/i18n-bridge.ts", () => ({
  t: (_key: string, fallback: string) => fallback,
  i18nAvailable: false,
  i18nInitDone: false,
  I18N_NAMESPACE: "pi-wishlist",
}));

import { handleInlineEditInput, renderInlineEditValue } from "./inline-edit.ts";
import type { InlineEditState } from "./types.ts";

function makeEditing(buffer = "", cursor = 0): InlineEditState {
  return { buffer, cursor };
}

describe("handleInlineEditInput", () => {
  describe("left/right movement", () => {
    it("moves cursor left by one character", () => {
      const e = makeEditing("hello", 3);
      handleInlineEditInput(e, "\x1b[D"); // left arrow
      expect(e.cursor).toBe(2);
    });

    it("moves cursor right by one character", () => {
      const e = makeEditing("hello", 3);
      handleInlineEditInput(e, "\x1b[C"); // right arrow
      expect(e.cursor).toBe(4);
    });

    it("clamps cursor at 0 moving left", () => {
      const e = makeEditing("hi", 0);
      handleInlineEditInput(e, "\x1b[D");
      expect(e.cursor).toBe(0);
    });

    it("clamps cursor at buffer length moving right", () => {
      const e = makeEditing("hi", 2);
      handleInlineEditInput(e, "\x1b[C");
      expect(e.cursor).toBe(2);
    });
  });

  describe("word jumps", () => {
    it("jumps to beginning of previous word", () => {
      const e = makeEditing("hello world foo", "hello world ".length); // cursor before "foo"
      handleInlineEditInput(e, "\x1b[1;5D"); // alt+left
      expect(e.cursor).toBe("hello ".length); // before "world"
    });

    it("jumps to end of next word", () => {
      const e = makeEditing("hello world", "hello ".length); // cursor after "hello "
      handleInlineEditInput(e, "\x1b[1;5C"); // alt+right
      expect(e.cursor).toBe("hello world".length);
    });
  });

  describe("home/end", () => {
    it("moves to start of line", () => {
      const e = makeEditing("hello world", 5);
      handleInlineEditInput(e, "\x1b[H"); // home
      expect(e.cursor).toBe(0);
    });

    it("moves to end of line", () => {
      const e = makeEditing("hello", 2);
      handleInlineEditInput(e, "\x1b[F"); // end
      expect(e.cursor).toBe(5);
    });
  });

  describe("backspace", () => {
    it("deletes character before cursor", () => {
      const e = makeEditing("hello", 4);
      handleInlineEditInput(e, "\x7f");
      expect(e.buffer).toBe("helo");
      expect(e.cursor).toBe(3);
    });

    it("does nothing at position 0", () => {
      const e = makeEditing("hi", 0);
      handleInlineEditInput(e, "\x7f");
      expect(e.buffer).toBe("hi");
      expect(e.cursor).toBe(0);
    });
  });

  describe("delete", () => {
    it("deletes character at cursor", () => {
      const e = makeEditing("hello", 2);
      handleInlineEditInput(e, "\x1b[3~"); // delete
      expect(e.buffer).toBe("helo"); // deleted 'l' at index 2
      expect(e.cursor).toBe(2);
    });

    it("does nothing at end of line", () => {
      const e = makeEditing("hi", 2);
      handleInlineEditInput(e, "\x1b[3~");
      expect(e.buffer).toBe("hi");
    });
  });

  describe("ctrl+u clear line", () => {
    it("clears buffer and resets cursor", () => {
      const e = makeEditing("hello world", 5);
      handleInlineEditInput(e, "\x15"); // ctrl+u
      expect(e.buffer).toBe("");
      expect(e.cursor).toBe(0);
    });
  });

  describe("character insertion", () => {
    it("inserts plain character at cursor", () => {
      const e = makeEditing("hllo", 1);
      handleInlineEditInput(e, "e");
      expect(e.buffer).toBe("hello");
      expect(e.cursor).toBe(2);
    });

    it("appends at end of buffer", () => {
      const e = makeEditing("hi", 2);
      handleInlineEditInput(e, "!");
      expect(e.buffer).toBe("hi!");
      expect(e.cursor).toBe(3);
    });

    it("inserts at beginning of buffer", () => {
      const e = makeEditing("ello", 0);
      handleInlineEditInput(e, "h");
      expect(e.buffer).toBe("hello");
      expect(e.cursor).toBe(1);
    });

    it("ignores control characters", () => {
      const e = makeEditing("hi", 2);
      handleInlineEditInput(e, "\n");
      handleInlineEditInput(e, "\r");
      expect(e.buffer).toBe("hi");
      expect(e.cursor).toBe(2);
    });
  });

  describe("return value", () => {
    it("returns true when state changed", () => {
      const e = makeEditing("hi", 2);
      expect(handleInlineEditInput(e, "!")).toBe(true);
    });

    it("returns false for unrecognized input", () => {
      const e = makeEditing("hi", 2);
      expect(handleInlineEditInput(e, "\x1bOP")).toBe(false); // F1
    });
  });
});

describe("renderInlineEditValue — snapshot", () => {
  it("matches snapshot: cursor at end", () => {
    expect(renderInlineEditValue(makeEditing("hello", 5))).toMatchSnapshot();
  });

  it("matches snapshot: cursor at beginning", () => {
    expect(renderInlineEditValue(makeEditing("hello", 0))).toMatchSnapshot();
  });

  it("matches snapshot: cursor in middle", () => {
    expect(renderInlineEditValue(makeEditing("hello", 2))).toMatchSnapshot();
  });

  it("matches snapshot: empty buffer", () => {
    expect(renderInlineEditValue(makeEditing("", 0))).toMatchSnapshot();
  });

  it("matches snapshot: CJK characters", () => {
    expect(renderInlineEditValue(makeEditing("需要等待 v2", 4))).toMatchSnapshot();
  });
});