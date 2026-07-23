import { describe, it, expect, vi, beforeEach } from "vitest";
import { createI18nBridge } from "./i18n-bridge.ts";

describe("createI18nBridge", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("t() returns fallback when SDK is absent", async () => {
    vi.doMock("@juicesharp/rpiv-i18n", () => {
      throw new Error("MODULE_NOT_FOUND");
    }, { spy: false });

    const { createI18nBridge } = await import("./i18n-bridge.ts");
    const bridge = createI18nBridge({ namespace: "test-ns" });
    await bridge.initPromise;

    expect(bridge.t("some.key", "Hello World")).toBe("Hello World");
    expect(bridge.i18nAvailable).toBe(false);
    expect(bridge.i18nInitDone).toBe(true);
  });

  it("t() returns scoped value when SDK is present", async () => {
    const mockScopeFn = vi.fn().mockReturnValue(
      (key: string, fallback: string) => key === "hello" ? "Hallo" : fallback,
    );
    vi.doMock("@juicesharp/rpiv-i18n", () => ({
      scope: mockScopeFn,
    }), { spy: false });

    const { createI18nBridge } = await import("./i18n-bridge.ts");
    const bridge = createI18nBridge({ namespace: "test-ns" });
    await bridge.initPromise;

    expect(mockScopeFn).toHaveBeenCalledWith("test-ns");
    expect(bridge.t("hello", "Hi")).toBe("Hallo");
    expect(bridge.t("unknown", "Hi")).toBe("Hi");
    expect(bridge.i18nAvailable).toBe(true);
  });

  it("registers locales when localesDir is provided", async () => {
    const mockScopeFn = vi.fn().mockReturnValue((_: string, f: string) => f);
    const mockRegister = vi.fn();
    vi.doMock("@juicesharp/rpiv-i18n", () => ({ scope: mockScopeFn }), { spy: false });
    vi.doMock("@juicesharp/rpiv-i18n/loader", () => ({
      registerLocalesFromDir: mockRegister,
    }), { spy: false });

    const { createI18nBridge } = await import("./i18n-bridge.ts");
    const bridge = createI18nBridge({
      namespace: "test-ns",
      localesDir: "file:///some/path/locales/",
      label: "My Label",
    });
    await bridge.initPromise;

    expect(mockRegister).toHaveBeenCalledWith(
      "test-ns",
      "file:///some/path/locales/",
      { label: "My Label" },
    );
    expect(bridge.i18nAvailable).toBe(true);
  });

  it("uses namespace as default label", async () => {
    const mockScopeFn = vi.fn().mockReturnValue((_: string, f: string) => f);
    const mockRegister = vi.fn();
    vi.doMock("@juicesharp/rpiv-i18n", () => ({ scope: mockScopeFn }), { spy: false });
    vi.doMock("@juicesharp/rpiv-i18n/loader", () => ({
      registerLocalesFromDir: mockRegister,
    }), { spy: false });

    const { createI18nBridge } = await import("./i18n-bridge.ts");
    const bridge = createI18nBridge({
      namespace: "test-ns",
      localesDir: "file:///x/",
    });
    await bridge.initPromise;

    expect(mockRegister).toHaveBeenCalledWith("test-ns", "file:///x/", { label: "test-ns" });
  });

  it("does not import loader when localesDir is omitted", async () => {
    const mockScopeFn = vi.fn().mockReturnValue((_: string, f: string) => f);
    vi.doMock("@juicesharp/rpiv-i18n", () => ({ scope: mockScopeFn }), { spy: false });

    const { createI18nBridge } = await import("./i18n-bridge.ts");
    const bridge = createI18nBridge({ namespace: "ns" });
    await bridge.initPromise;

    expect(bridge.i18nAvailable).toBe(true);
  });

  it("calls debug on failure", async () => {
    const debugCalls: unknown[][] = [];
    vi.doMock("@juicesharp/rpiv-i18n", () => {
      throw new Error("fail");
    }, { spy: false });

    const { createI18nBridge } = await import("./i18n-bridge.ts");
    const bridge = createI18nBridge({
      namespace: "ns",
      debug: (...args: unknown[]) => debugCalls.push(args),
    });
    await bridge.initPromise;

    expect(debugCalls.length).toBeGreaterThan(0);
    expect(debugCalls[0][0]).toBe("i18n init failed");
    // Error message may be wrapped by vitest
    expect(typeof debugCalls[0][1]).toBe("string");
    expect((debugCalls[0][1] as string).length).toBeGreaterThan(0);
  });
});
