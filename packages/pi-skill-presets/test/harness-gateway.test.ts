/**
 * Unit tests for the test harness's gateway-pick structure defense (ocr N1):
 * any malformed models.json shape must degrade to "no available models"
 * (undefined) instead of throwing and breaking test-file loading.
 */

import { describe, expect, it } from "vitest";
import { pickGatewayFromRaw } from "./helpers/gateway-pick.ts";

const PINNED = "glm53-flash-internal";

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
      apiKey: "k",
    });
  });

  it("hosting pick without a usable baseUrl does not silently fall back", () => {
    const raw = {
      providers: {
        host: { models: [{ id: PINNED }] },
        fb: { baseUrl: "http://fallback.example" },
      },
    };
    expect(pickGatewayFromRaw(raw, PINNED)).toBeUndefined();
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
      apiKey: "k",
    });
  });
});
