/**
 * fx — 公共面：四端口接口 + 每端口真壳（#31 fx:Effects；模块 spec fx.md；票 12）。
 *
 * fx 是零实现 seam 集合：端口类型只用原始值，零业务逻辑零包内依赖
 * （eda-leaf-zero-dep-fx 机器强制，故端口类型不可能泄漏 domain 业务类型）。
 *
 * 每端口恰好两 adapter（深模块审查裁定）：真壳 lib/{clock,exec,pusher,node-fs}.ts（票 12）；fake lib/fakes.ts（票 13）。
 * update_hook 与第五停点（持久化写）不属 fx——Store 接口自身契约（store spec）。
 */
export type { Clock, Exec, ExecOptions, ExecResult, Pusher, Fs } from "./lib/types.ts";
export { SystemClock } from "./lib/clock.ts";
export { ShellExec } from "./lib/exec.ts";
export { SocketPusher } from "./lib/pusher.ts";
export { NodeFs } from "./lib/node-fs.ts";
export { FileLock, defaultPidPath } from "./lib/lockfile.ts"; // 票 38：单活仲裁真壳（A 层禁 node IO，锁原语归 fx）
export { FakeClock, FakeExec, FakeFs, FakePusher } from "./lib/fakes.ts";
