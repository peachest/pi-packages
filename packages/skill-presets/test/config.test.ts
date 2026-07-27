import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import * as os from "node:os";
import {
  readPresetsConfig,
  writePresetsConfig,
  getPresetSkills,
  getDefaultPresetName,
  getAgentDir,
} from "../src/config.js";
import type { PresetsConfig } from "../src/types.js";

// Use a temp directory for test settings
const TMP_DIR = resolve(os.tmpdir(), `skill-presets-test-${Date.now()}`);
const AGENT_DIR = resolve(TMP_DIR, "agent");
const PROJECT_DIR = resolve(TMP_DIR, "project");

describe("config", () => {
  beforeEach(() => {
    // Set PI_CODING_AGENT_DIR to our temp dir
    process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
    mkdirSync(AGENT_DIR, { recursive: true });
    mkdirSync(resolve(PROJECT_DIR, ".pi"), { recursive: true });
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe("getAgentDir", () => {
    it("uses PI_CODING_AGENT_DIR env var", () => {
      expect(getAgentDir()).toBe(AGENT_DIR);
    });

    it("falls back to ~/.pi/agent when env not set", () => {
      delete process.env.PI_CODING_AGENT_DIR;
      const expected = resolve(os.homedir(), ".pi/agent");
      expect(getAgentDir()).toBe(expected);
    });
  });

  describe("readPresetsConfig", () => {
    it("returns empty config when no settings.json exists", () => {
      const config = readPresetsConfig(PROJECT_DIR);
      expect(config.definitions).toEqual({});
      expect(config.default).toBeUndefined();
    });

    it("reads global settings.json", () => {
      const settings = {
        presets: {
          default: "engineer",
          definitions: {
            engineer: { skills: ["wayfinder", "tdd"] },
          },
        },
      };
      writeFileSync(
        resolve(AGENT_DIR, "settings.json"),
        JSON.stringify(settings),
      );

      const config = readPresetsConfig(PROJECT_DIR);
      expect(config.default).toBe("engineer");
      expect(config.definitions.engineer.skills).toEqual(["wayfinder", "tdd"]);
    });

    it("reads project settings.json", () => {
      const settings = {
        presets: {
          definitions: {
            ddd: { skills: ["domain-modeling"] },
          },
        },
      };
      writeFileSync(
        resolve(PROJECT_DIR, ".pi", "settings.json"),
        JSON.stringify(settings),
      );

      const config = readPresetsConfig(PROJECT_DIR);
      expect(config.definitions.ddd.skills).toEqual(["domain-modeling"]);
    });

    it("merges global and project settings (project overrides)", () => {
      writeFileSync(
        resolve(AGENT_DIR, "settings.json"),
        JSON.stringify({
          presets: {
            default: "engineer",
            definitions: {
              engineer: { skills: ["wayfinder"] },
              ddd: { skills: ["domain-modeling"] },
            },
          },
        }),
      );
      writeFileSync(
        resolve(PROJECT_DIR, ".pi", "settings.json"),
        JSON.stringify({
          presets: {
            default: "ddd",
            definitions: {
              ddd: { skills: ["ubiquitous-language"] },
            },
          },
        }),
      );

      const config = readPresetsConfig(PROJECT_DIR);
      // Project default overrides global
      expect(config.default).toBe("ddd");
      // Project preset overrides global for same name
      expect(config.definitions.ddd.skills).toEqual(["ubiquitous-language"]);
      // Global-only preset is preserved
      expect(config.definitions.engineer.skills).toEqual(["wayfinder"]);
    });

    it("handles invalid JSON gracefully", () => {
      writeFileSync(
        resolve(AGENT_DIR, "settings.json"),
        "not valid json {{{",
      );
      const config = readPresetsConfig(PROJECT_DIR);
      expect(config.definitions).toEqual({});
    });

    it("handles settings without presets field", () => {
      writeFileSync(
        resolve(AGENT_DIR, "settings.json"),
        JSON.stringify({ skills: ["+some-skill"], theme: "dark" }),
      );
      const config = readPresetsConfig(PROJECT_DIR);
      expect(config.definitions).toEqual({});
      expect(config.default).toBeUndefined();
    });
  });

  describe("writePresetsConfig", () => {
    it("writes presets to global settings.json preserving other fields", () => {
      writeFileSync(
        resolve(AGENT_DIR, "settings.json"),
        JSON.stringify({ theme: "dark", skills: ["+skill1"] }),
      );

      const config: PresetsConfig = {
        default: "engineer",
        definitions: { engineer: { skills: ["wayfinder"] } },
      };
      writePresetsConfig(config, "global");

      const raw = JSON.parse(
        readFileSync(resolve(AGENT_DIR, "settings.json"), "utf-8"),
      );
      expect(raw.theme).toBe("dark");
      expect(raw.skills).toEqual(["+skill1"]);
      expect(raw.presets.default).toBe("engineer");
      expect(raw.presets.definitions.engineer.skills).toEqual(["wayfinder"]);
    });

    it("writes presets to project settings.json", () => {
      const config: PresetsConfig = {
        definitions: { ddd: { skills: ["domain-modeling"] } },
      };
      writePresetsConfig(config, "project", PROJECT_DIR);

      const raw = JSON.parse(
        readFileSync(
          resolve(PROJECT_DIR, ".pi", "settings.json"),
          "utf-8",
        ),
      );
      expect(raw.presets.definitions.ddd.skills).toEqual(["domain-modeling"]);
    });
  });

  describe("getPresetSkills", () => {
    it("returns skills for existing preset", () => {
      const config: PresetsConfig = {
        definitions: { engineer: { skills: ["a", "b", "c"] } },
      };
      expect(getPresetSkills(config, "engineer")).toEqual(["a", "b", "c"]);
    });

    it("returns undefined for missing preset", () => {
      const config: PresetsConfig = { definitions: {} };
      expect(getPresetSkills(config, "nonexistent")).toBeUndefined();
    });
  });

  describe("getDefaultPresetName", () => {
    it("returns the default preset name", () => {
      const config: PresetsConfig = {
        default: "engineer",
        definitions: { engineer: { skills: [] } },
      };
      expect(getDefaultPresetName(config)).toBe("engineer");
    });

    it("returns undefined when no default set", () => {
      const config: PresetsConfig = { definitions: {} };
      expect(getDefaultPresetName(config)).toBeUndefined();
    });
  });
});
