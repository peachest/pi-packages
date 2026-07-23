/* ------------------------------------------------------------------ */
/*  Debug utility tests                                               */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, afterEach } from "vitest";

describe("debugLog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not output when WISHLIST_DEBUG is not set", async () => {
    delete process.env.WISHLIST_DEBUG;
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { debugLog } = await import("./debug.ts");
    debugLog("tracker", "test message");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("outputs when WISHLIST_DEBUG is set", async () => {
    process.env.WISHLIST_DEBUG = "1";
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { debugLog } = await import("./debug.ts");
    debugLog("checker", "fetch failed");
    expect(console.error).toHaveBeenCalledTimes(1);
    const call = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("[wishlist:checker]");
    expect(call[1]).toBe("fetch failed");
  });

  it("includes extra args JSON-stringified", async () => {
    process.env.WISHLIST_DEBUG = "1";
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { debugLog } = await import("./debug.ts");
    debugLog("main", "error", { code: 500 });
    const call = (console.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toBe(JSON.stringify({ code: 500 }));
  });
});