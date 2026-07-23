/* ------------------------------------------------------------------ */
/*  Edit-note tests                                                    */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../state/i18n-bridge.ts", () => ({
  t: (_key: string, fallback: string) => fallback,
}));
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

let mockDir: string;

beforeEach(() => {
  mockDir = join(tmpdir(), `pi-wishlist-edit-${randomBytes(4).toString("hex")}`);
  mkdirSync(mockDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(mockDir)) rmSync(mockDir, { recursive: true });
});

describe("handleEditNote", () => {
  it("updates note for existing package", async () => {
    const { handleEditNote } = await import("./edit-note.ts");
    const { addPackage, getPackage, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    addPackage("npm:lodash", "npm:lodash");

    const result = handleEditNote("npm:lodash", "等待 v5");
    expect(result).toBeNull();
    expect(getPackage("npm:lodash")!.notes).toBe("等待 v5");
  });

  it("clears note when note is empty", async () => {
    const { handleEditNote } = await import("./edit-note.ts");
    const { addPackage, getPackage, setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);
    addPackage("npm:lodash", "npm:lodash", "旧备注");

    handleEditNote("npm:lodash", "");
    // deepMerge sets notes to "" which is falsy in display code
    expect(getPackage("npm:lodash")!.notes).toBe("");
  });

  it("returns error for non-existent package", async () => {
    const { handleEditNote } = await import("./edit-note.ts");
    const { setDataDir } = await import("./wishlist.ts");
    setDataDir(mockDir);

    const err = handleEditNote("npm:none", "test");
    expect(err).toContain("not in the wishlist");
  });
});

describe("parseEditArgs", () => {
  it("parses key and note", async () => {
    const { parseEditArgs } = await import("./edit-note.ts");
    const result = parseEditArgs(["npm:lodash", "--note", "test note"]);
    if ("error" in result) throw new Error(result.error);
    expect(result.key).toBe("npm:lodash");
    expect(result.note).toBe("test note");
  });

  it("returns error when no args", async () => {
    const { parseEditArgs } = await import("./edit-note.ts");
    const result = parseEditArgs([]);
    if ("error" in result) expect(result.error).toContain("usage");
    else throw new Error("expected error");
  });

  it("returns empty note when --note absent", async () => {
    const { parseEditArgs } = await import("./edit-note.ts");
    const result = parseEditArgs(["npm:lodash"]);
    if ("error" in result) throw new Error(result.error);
    expect(result.key).toBe("npm:lodash");
    expect(result.note).toBe("");
  });
});