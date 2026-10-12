import { exec as nodeExec } from "node:child_process";
import type { Exec, ExecOptions, ExecResult } from "./types.ts";

/** 真执行薄 adapter：shell 命令行转发到 child_process.exec，结果原形上抛。 */
export class ShellExec implements Exec {
  run(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return new Promise((resolve) => {
      nodeExec(
        command,
        {
          timeout: opts?.timeoutMs,
          env: opts?.env ? { ...process.env, ...opts.env } : undefined,
        },
        (err: (Error & { code?: number | string; signal?: string; killed?: boolean }) | null, stdout, stderr) => {
          const e = err;
          resolve({
            exitCode: e === null ? 0 : typeof e.code === "number" ? e.code : null,
            signal: e?.signal ?? null,
            stdout,
            stderr,
            timedOut: e?.killed === true,
          });
        },
      );
    });
  }
}
