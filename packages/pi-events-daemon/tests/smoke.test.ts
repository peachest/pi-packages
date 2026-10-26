import { describe, it, expect } from "vitest";
import * as daemon from "../index.ts";

describe("package scaffold (ticket 01)", () => {
  it("exports all 11 module namespaces", () => {
    for (const ns of ["protocol","domain","store","kernel","profiles","prober","transcriptAdapter","loops","fx","transport","daemonMain"]) {
      expect(daemon).toHaveProperty(ns);
    }
  });
});
