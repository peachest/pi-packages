/**
 * Harness env hygiene (ocr R13M): createTestSession overwrites the
 * process-level PI_CODING_AGENT_DIR for the whole session lifetime; the shared
 * restoreAgentDirEnv() teardown must put the pre-test value back exactly —
 * a pre-existing value must survive, not be bare-deleted.
 *
 * Gated on `suite` like the other harness consumers: this exercises the same
 * real-session creation path (loader.reload + bindExtensions).
 */

import { afterAll, expect, it } from "vitest";
import {
  cleanupMadeDirs,
  createTestSession,
  restoreAgentDirEnv,
  suite,
} from "./helpers/preset-harness.ts";

afterAll(() => {
  restoreAgentDirEnv();
  cleanupMadeDirs();
});

suite("harness env restore (ocr R13M)", () => {
  it("running with PI_CODING_AGENT_DIR=/custom/agent restores it after teardown", async () => {
    process.env.PI_CODING_AGENT_DIR = "/custom/agent";
    const session = await createTestSession({
      settings: { presets: { definitions: {} } },
    });
    expect(session).toBeTruthy();
    // The harness must keep pointing the env at its temp dir for the whole
    // session lifetime (the extension reads it lazily) — no early restore.
    expect(process.env.PI_CODING_AGENT_DIR).toMatch(/^.*preset-harness-agent-/);
    restoreAgentDirEnv();
    expect(process.env.PI_CODING_AGENT_DIR).toBe("/custom/agent");
  });
});
