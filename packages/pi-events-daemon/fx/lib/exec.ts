import { spawn } from "node:child_process";
import type { Exec, ExecOptions, ExecResult } from "./types.ts";

/** SIGTERM→SIGKILL 升级宽限期：给忽略 TERM 的 hung checker（shell trap）一次体面退出的机会，仍不退则整组强杀。 */
const KILL_GRACE_MS = 5_000;

/**
 * 真执行薄 adapter：shell 命令行转发到 child_process.spawn（shell:true 与 exec 同为 /bin/sh -c 语义）。
 * 超时升级（Exec 契约：timeoutMs 后 run 必结算，hung checker 不得挂死承诺 wedge 池）：
 * 到点先 SIGTERM 整进程组（detached:true → sh 为组长），KILL_GRACE_MS 内未退出则 SIGKILL 整进程组。
 */
export class ShellExec implements Exec {
  run(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        // detached:true → sh 为新进程组长：超时杀形经 kill(-pid) 覆盖整组，sh 的子进程（curl/sleep…）无从豁免
        detached: true,
        env: opts?.env ? { ...opts.env } : undefined,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let graceTimer: NodeJS.Timeout | null = null;
      // shortcut: stdout/stderr 无上限累积（旧 exec maxBuffer 1MB 语义未保留）——probe evidence 均为短文本；出现大输出 checker 需补上限
      child.stdout.on("data", (d: Buffer) => void (stdout += d));
      child.stderr.on("data", (d: Buffer) => void (stderr += d));
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        finish();
      };
      child.on("close", (exitCode, signal) =>
        settle(() => resolve({ exitCode, signal: signal ?? null, stdout, stderr, timedOut })),
      );
      child.on("error", (err) => settle(() => reject(err)));
      if (opts?.timeoutMs === undefined) return;
      const killGroup = (sig: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig); // 负 pid = 整进程组（POSIX）；组不存在（已退出）即无事可杀
        } catch {
          // 进程组已消失：忽略
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        graceTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
        graceTimer.unref();
      }, opts.timeoutMs);
      timer.unref();
    });
  }
}
