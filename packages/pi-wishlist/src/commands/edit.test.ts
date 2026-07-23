/* ------------------------------------------------------------------ */
/*  Pi Wishlist — edit command tests                                  */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("handleEdit", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("edits note for a package", async () => {
    vi.doMock("../data/edit-note.ts", () => ({
      parseEditArgs: () => ({ key: "npm:lodash", note: "my note" }),
      handleEditNote: () => undefined,
    }));

    const { handleEdit } = await import("./edit.ts");
    const result = await handleEdit(["npm:lodash", "my note"]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.key).toBe("npm:lodash");
      expect(result.data.note).toBe("my note");
    }
  });

  it("clears note when no note provided", async () => {
    vi.doMock("../data/edit-note.ts", () => ({
      parseEditArgs: () => ({ key: "npm:lodash", note: "" }),
      handleEditNote: () => undefined,
    }));

    const { handleEdit } = await import("./edit.ts");
    const result = await handleEdit(["npm:lodash"]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.key).toBe("npm:lodash");
      expect(result.data.note).toBe("");
    }
  });

  it("returns error on parse failure", async () => {
    vi.doMock("../data/edit-note.ts", () => ({
      parseEditArgs: () => ({ error: "Invalid args" }),
    }));

    const { handleEdit } = await import("./edit.ts");
    const result = await handleEdit([]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Invalid args");
    }
  });

  it("returns error when edit-note fails", async () => {
    vi.doMock("../data/edit-note.ts", () => ({
      parseEditArgs: () => ({ key: "npm:lodash", note: "bad note" }),
      handleEditNote: () => "Error updating note",
    }));

    const { handleEdit } = await import("./edit.ts");
    const result = await handleEdit(["npm:lodash", "bad note"]);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Error updating note");
    }
  });
});