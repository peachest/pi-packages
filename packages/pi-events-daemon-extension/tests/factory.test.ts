/**
 * Ticket 34 — 包入口：默认导出工厂向 pi 注册 9 op 工具（安装面结构断言）。
 */
import { describe, expect, it } from "vitest";
import { OP_NAMES } from "pi-events-daemon/protocol.ts";
import eventsDaemonExtension, { loadOpSchema } from "../index.ts";

describe("票 34：pi install 结构面——包 manifest 指向的工厂注册 9 工具", () => {
  it("工厂注册 9 op 工具（fake pi 捕获）", () => {
    const registered: Array<{ name: string }> = [];
    const pi = {
      registerTool: (tool: { name: string }) => registered.push(tool),
      on: () => () => {},
    } as unknown as Parameters<typeof eventsDaemonExtension>[0];
    eventsDaemonExtension(pi, { opSchema: loadOpSchema(), sender: async () => ({}) });
    expect(registered.map((t) => t.name).sort()).toEqual([...OP_NAMES].sort());
  });
});
