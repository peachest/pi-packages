/**
 * Unit tests for the test harness's gateway-pick structure defense (ocr N1):
 * any malformed models.json shape must degrade to "no available models"
 * (undefined) instead of throwing and breaking test-file loading.
 */

import { describe, expect, it } from "vitest";
import { pickGatewayFromRaw, pickPinnedModel } from "./helpers/gateway-pick.ts";

const PINNED = "glm53-flash-internal";

describe("pickPinnedModel single-provider pin (ocr R6M3)", () => {
  const available = [
    { provider: "a", id: "other" },
    { provider: "b", id: "glm53-flash-internal" },
    { provider: "a", id: "glm53-flash-internal" },
  ];

  it("picks only the pinned model under the probed provider", () => {
    expect(pickPinnedModel(available, "a", "glm53-flash-internal")).toEqual({
      provider: "a",
      id: "glm53-flash-internal",
    });
    expect(pickPinnedModel(available, "b", "glm53-flash-internal")).toEqual({
      provider: "b",
      id: "glm53-flash-internal",
    });
  });

  it("never falls back to another provider hosting the pinned model", () => {
    // "a" probes/reachability belongs to provider a; the model must not
    // resolve from b when a does not carry it.
    expect(pickPinnedModel([available[0], available[1]], "a", "glm53-flash-internal")).toBeUndefined();
  });

  it("returns undefined for absent model or absent gateway", () => {
    expect(pickPinnedModel(available, "a", "missing")).toBeUndefined();
    expect(pickPinnedModel(available, undefined, "glm53-flash-internal")).toBeUndefined();
  });
});

describe("pickGatewayFromRaw structure defense (ocr N1)", () => {
  it("returns undefined for null provider values", () => {
    expect(pickGatewayFromRaw({ providers: { bad: null } }, PINNED)).toBeUndefined();
  });

  it("returns undefined for non-array models", () => {
    expect(
      pickGatewayFromRaw({ providers: { bad: { models: {} } } }, PINNED),
    ).toBeUndefined();
  });

  it("returns undefined for null model entries", () => {
    expect(
      pickGatewayFromRaw({ providers: { bad: { models: [null] } } }, PINNED),
    ).toBeUndefined();
  });

  it("returns undefined for non-object roots and missing providers map", () => {
    expect(pickGatewayFromRaw(null, PINNED)).toBeUndefined();
    expect(pickGatewayFromRaw([1, 2], PINNED)).toBeUndefined();
    expect(pickGatewayFromRaw({}, PINNED)).toBeUndefined();
    expect(pickGatewayFromRaw({ providers: [] }, PINNED)).toBeUndefined();
  });

  it("finds the hosting provider and passes apiKey through", () => {
    const raw = {
      providers: {
        fallback: { baseUrl: "http://fallback.example" },
        host: {
          baseUrl: "https://host.example",
          apiKey: "sk-test",
          models: [{ id: "other" }, { id: PINNED }],
        },
      },
    };
    expect(pickGatewayFromRaw(raw, PINNED)).toEqual({
      baseUrl: "https://host.example",
      provider: "host",
      apiKey: "sk-test",
    });
  });

  it("skips junk entries among providers and falls back to first http baseUrl", () => {
    const raw = {
      providers: {
        junk: "not-an-object",
        arr: [],
        nullish: null,
        fb: { baseUrl: "http://fallback.example", apiKey: "k" },
      },
    };
    expect(pickGatewayFromRaw(raw, PINNED)).toEqual({
      baseUrl: "http://fallback.example",
      provider: "fb",
      apiKey: "k",
    });
  });

  it("hosting pick with an unusable baseUrl falls back to a valid provider (ocr R4M1)", () => {
    const raw = {
      providers: {
        host: { models: [{ id: PINNED }] },
        fb: { baseUrl: "http://fallback.example" },
      },
    };
    expect(pickGatewayFromRaw(raw, PINNED)).toEqual({
      baseUrl: "http://fallback.example",
      provider: "fb",
    });
  });

  it("invalid-URL hoster listed first is skipped for a later valid provider (ocr R4M1)", () => {
    const raw = {
      providers: {
        host: { baseUrl: "httpx://bad", models: [{ id: PINNED }] },
        good: { baseUrl: "https://good.example", apiKey: "k" },
      },
    };
    expect(pickGatewayFromRaw(raw, PINNED)).toEqual({
      baseUrl: "https://good.example",
      provider: "good",
      apiKey: "k",
    });
  });

  it("skips providers with invalid baseUrl and picks the next valid one (ocr R1)", () => {
    const raw = {
      providers: {
        bad: { baseUrl: "httpx://bad" },
        good: { baseUrl: "https://good.example", apiKey: "k" },
      },
    };
    expect(pickGatewayFromRaw(raw, PINNED)).toEqual({
      baseUrl: "https://good.example",
      provider: "good",
      apiKey: "k",
    });
  });

  it("a hosting provider with credentials in the URL falls back to a valid provider (ocr R5M2)", () => {
    const raw = {
      providers: {
        host: { baseUrl: "https://user:pass@host.example", models: [{ id: PINNED }] },
        fb: { baseUrl: "http://fallback.example" },
      },
    };
    expect(pickGatewayFromRaw(raw, PINNED)).toEqual({
      baseUrl: "http://fallback.example",
      provider: "fb",
    });
  });

  it("rejects username-only and password-only credential URLs (ocr R5M2)", () => {
    const raw = {
      providers: {
        userOnly: { baseUrl: "https://user@host.example" },
        passOnly: { baseUrl: "https://:pass@host.example" },
        good: { baseUrl: "https://good.example" },
      },
    };
    expect(pickGatewayFromRaw(raw, PINNED)).toEqual({
      baseUrl: "https://good.example",
      provider: "good",
    });
  });
});
