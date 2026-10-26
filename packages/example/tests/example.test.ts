import { describe, expect, it } from "vitest";
// Tests go through entry points like everyone else — never ../lib/impl.
import { exampleGreet } from "../index.ts";

describe("example package", () => {
  it("greets through the entry point", () => {
    expect(exampleGreet("pi")).toBe("Hello, pi!");
  });
});