import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPresetsConfig } from "../index.ts";

/**
 * readSettingsFile error handling (ocr R12M1): no existsSync pre-check —
 * a missing file is legal ({}) detected via ENOENT only; any other read
 * error (EACCES = present but inaccessible) must surface as a throw so the
 * tri-state guards downstream refuse to operate, instead of silently
 * treating an unreadable settings.json as an empty config.
 *
 * node:fs readFileSync is mocked so both errno cases are reproducible
 * regardless of the test user's privileges (root ignores chmod 000).
 */

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code, errno: -1 });
}

describe("readSettingsFile errno handling (ocr R12M1)", () => {
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "preset-cfg-read-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "preset-cfg-read-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    vi.mocked(readFileSync).mockReset();
  });

  it("returns an empty config when the file is missing (ENOENT)", () => {
    // Even if some layer reports the file as existing, ENOENT from the read
    // itself is the only "missing" signal — and it must yield {}, not throw.
    vi.mocked(readFileSync).mockImplementation(() => {
      throw errnoError("ENOENT");
    });

    const config = readPresetsConfig(cwd);
    expect(config.definitions).toEqual({});
    expect(config.default).toBeUndefined();
  });

  it("throws on EACCES (present but no read permission)", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw errnoError("EACCES");
    });

    // Must NOT be swallowed into an empty config (that is what the removed
    // existsSync pre-check did: EACCES → existsSync false → {}).
    expect(() => readPresetsConfig(cwd)).toThrow(/EACCES/);
  });
});
