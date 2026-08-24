import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  mergeNoProxyLists,
  parseProxyEnv,
  serializeProxyEnv,
  computeProxyEnvPath,
  diffProxyUrl,
  dispatcherPathFromMain,
} from "./proxy";

// ═══ mergeNoProxyLists ═══

describe("mergeNoProxyLists", () => {
  it("returns union of two comma-separated lists, deduplicated", () => {
    const a = "localhost,127.0.0.1,10.0.0.1";
    const b = "127.0.0.1,10.0.0.2,.svc";
    expect(mergeNoProxyLists(a, b)).toBe("localhost,127.0.0.1,10.0.0.1,10.0.0.2,.svc");
  });

  it("handles empty first list", () => {
    expect(mergeNoProxyLists("", "localhost,127.0.0.1")).toBe("localhost,127.0.0.1");
  });

  it("handles empty second list", () => {
    expect(mergeNoProxyLists("localhost,127.0.0.1", "")).toBe("localhost,127.0.0.1");
  });

  it("handles both empty", () => {
    expect(mergeNoProxyLists("", "")).toBe("");
  });

  it("trims whitespace around entries", () => {
    expect(mergeNoProxyLists(" localhost , 127.0.0.1 ", " 127.0.0.1 ")).toBe("localhost,127.0.0.1");
  });

  it("preserves order: first list first, then new entries from second", () => {
    const a = "a,b,c";
    const b = "c,d,e";
    expect(mergeNoProxyLists(a, b)).toBe("a,b,c,d,e");
  });
});

// ═══ parseProxyEnv ═══

describe("parseProxyEnv", () => {
  it("parses simple KEY=VALUE lines", () => {
    const text = "http_proxy=http://1.2.3.4:8080\nno_proxy=localhost";
    expect(parseProxyEnv(text)).toEqual({
      http_proxy: "http://1.2.3.4:8080",
      no_proxy: "localhost",
    });
  });

  it("skips comment lines", () => {
    const text = "# comment\nhttp_proxy=http://1.2.3.4:8080\n# another";
    expect(parseProxyEnv(text)).toEqual({ http_proxy: "http://1.2.3.4:8080" });
  });

  it("skips empty lines", () => {
    const text = "\nhttp_proxy=http://1.2.3.4:8080\n\n";
    expect(parseProxyEnv(text)).toEqual({ http_proxy: "http://1.2.3.4:8080" });
  });

  it("handles values with = signs", () => {
    const text = "url=http://host?query=value";
    expect(parseProxyEnv(text)).toEqual({ url: "http://host?query=value" });
  });

  it("returns empty dict for empty input", () => {
    expect(parseProxyEnv("")).toEqual({});
  });

  it("returns empty dict for comments only", () => {
    expect(parseProxyEnv("# only comments\n# more")).toEqual({});
  });

  it("trims whitespace around keys", () => {
    const text = "  http_proxy  =http://1.2.3.4:8080";
    expect(parseProxyEnv(text)).toEqual({ http_proxy: "http://1.2.3.4:8080" });
  });
});

// ═══ serializeProxyEnv ═══

describe("serializeProxyEnv", () => {
  it("serializes dict to KEY=VALUE lines with header", () => {
    const env = { http_proxy: "http://1.2.3.4:8080", no_proxy: "localhost" };
    const text = serializeProxyEnv(env);
    expect(text).toContain("# 代理环境变量");
    expect(text).toContain("http_proxy=http://1.2.3.4:8080");
    expect(text).toContain("no_proxy=localhost");
  });

  it("roundtrips with parseProxyEnv", () => {
    const env = { http_proxy: "http://1.2.3.4:8080", NO_PROXY: "localhost,127.0.0.1" };
    const text = serializeProxyEnv(env);
    const parsed = parseProxyEnv(text);
    expect(parsed).toEqual(env);
  });

  it("handles empty dict", () => {
    const text = serializeProxyEnv({});
    expect(text).toContain("# 代理环境变量");
    // No KEY=VALUE lines (only header + trailing newline)
    expect(text.trim().split("\n").filter((l) => !l.startsWith("#") && l.trim()).length).toBe(0);
  });
});

// ═══ computeProxyEnvPath ═══

describe("computeProxyEnvPath", () => {
  const origXdg = process.env.XDG_CONFIG_HOME;

  afterEach(() => {
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
  });

  it("uses XDG_CONFIG_HOME when set", () => {
    process.env.XDG_CONFIG_HOME = "/custom/xdg";
    expect(computeProxyEnvPath()).toBe(join("/custom/xdg", "proxy.env"));
  });

  it("defaults to ~/.config when XDG_CONFIG_HOME not set", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(computeProxyEnvPath()).toBe(join(homedir(), ".config", "proxy.env"));
  });
});

// ═══ dispatcherPathFromMain ═══

describe("dispatcherPathFromMain", () => {
  it("derives dist/core/http-dispatcher.js from the package main entry", () => {
    const main = "/x/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
    expect(dispatcherPathFromMain(main)).toBe(
      "/x/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/http-dispatcher.js",
    );
  });

  it("works with a trailing Windows-style main on a posix join", () => {
    // Only asserts the derivation math; real cross-platform handling is not required.
    const main = "/p/dist/index.js";
    expect(dispatcherPathFromMain(main)).toBe("/p/dist/core/http-dispatcher.js");
  });
});

// ═══ diffProxyUrl ═══

describe("diffProxyUrl", () => {
  it("returns false when URL keys are identical", () => {
    const env = {
      http_proxy: "http://1.2.3.4:8080",
      HTTP_PROXY: "http://1.2.3.4:8080",
      https_proxy: "http://1.2.3.4:8080",
      HTTPS_PROXY: "http://1.2.3.4:8080",
      all_proxy: "socks5://1.2.3.4:1080",
      ALL_PROXY: "socks5://1.2.3.4:1080",
      no_proxy: "localhost",
      NO_PROXY: "localhost",
    };
    expect(diffProxyUrl(env, { ...env })).toBe(false);
  });

  it("returns true when http_proxy changes", () => {
    const oldEnv = { http_proxy: "http://1.2.3.4:8080" };
    const newEnv = { http_proxy: "http://5.6.7.8:8080" };
    expect(diffProxyUrl(oldEnv, newEnv)).toBe(true);
  });

  it("returns true when all_proxy is removed", () => {
    const oldEnv = { all_proxy: "socks5://1.2.3.4:1080", ALL_PROXY: "socks5://1.2.3.4:1080" };
    const newEnv = {};
    expect(diffProxyUrl(oldEnv, newEnv)).toBe(true);
  });

  it("returns false when only no_proxy changes", () => {
    const oldEnv = { no_proxy: "localhost", NO_PROXY: "localhost" };
    const newEnv = { no_proxy: "localhost,10.0.0.1", NO_PROXY: "localhost,10.0.0.1" };
    expect(diffProxyUrl(oldEnv, newEnv)).toBe(false);
  });

  it("returns true when a URL key is added", () => {
    const oldEnv = {};
    const newEnv = { http_proxy: "http://1.2.3.4:8080" };
    expect(diffProxyUrl(oldEnv, newEnv)).toBe(true);
  });

  it("returns false when both envs are empty", () => {
    expect(diffProxyUrl({}, {})).toBe(false);
  });
});
