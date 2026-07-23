/* ------------------------------------------------------------------ */
/*  i18n-bridge tests — pi-wishlist specifics                          */
/*                                                                     */
/*  The shared i18n bridge logic is tested in packages/i18n-utils.     */
/*  These tests verify the pi-wishlist wrapper: namespace, debug,      */
/*  bridge export, and fallback behaviour.                             */
/* ------------------------------------------------------------------ */

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("pi-wishlist i18n-bridge", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports I18N_NAMESPACE", async () => {
    vi.doMock("pi-i18n-utils", () => ({
      createI18nBridge: () => ({
        t: (k: string, f: string) => f,
        i18nAvailable: false,
        i18nInitDone: true,
        initPromise: Promise.resolve(),
      }),
    }), { spy: false });

    vi.unmock("../../src/state/i18n-bridge.ts");
    const { I18N_NAMESPACE } = await import("../../src/state/i18n-bridge.ts");
    expect(I18N_NAMESPACE).toBe("pi-wishlist");
  });

  it("t() delegates to shared bridge", async () => {
    const bridgeT = vi.fn((key: string, fallback: string) => {
      if (key === "hello") return "Hallo";
      return fallback;
    });
    vi.doMock("pi-i18n-utils", () => ({
      createI18nBridge: () => ({
        t: bridgeT,
        i18nAvailable: true,
        i18nInitDone: true,
        initPromise: Promise.resolve(),
      }),
    }), { spy: false });

    vi.unmock("../../src/state/i18n-bridge.ts");
    const { t } = await import("../../src/state/i18n-bridge.ts");

    expect(t("hello", "Hi")).toBe("Hallo");
    expect(t("unknown", "Hi")).toBe("Hi");
    expect(bridgeT).toHaveBeenCalledWith("hello", "Hi");
  });

  it("exports bridge with i18nAvailable", async () => {
    vi.doMock("pi-i18n-utils", () => ({
      createI18nBridge: () => ({
        t: (k: string, f: string) => f,
        i18nAvailable: true,
        i18nInitDone: true,
        initPromise: Promise.resolve(),
      }),
    }), { spy: false });

    vi.unmock("../../src/state/i18n-bridge.ts");
    const { bridge } = await import("../../src/state/i18n-bridge.ts");

    expect(bridge.i18nAvailable).toBe(true);
    expect(bridge.i18nInitDone).toBe(true);
  });

  it("bridge.i18nAvailable is false when SDK absent", async () => {
    vi.doMock("pi-i18n-utils", () => ({
      createI18nBridge: () => ({
        t: (k: string, f: string) => f,
        i18nAvailable: false,
        i18nInitDone: true,
        initPromise: Promise.resolve(),
      }),
    }), { spy: false });

    vi.unmock("../../src/state/i18n-bridge.ts");
    const { bridge } = await import("../../src/state/i18n-bridge.ts");

    expect(bridge.i18nAvailable).toBe(false);
  });
});
