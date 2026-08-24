/**
 * Poll Tool — pi extension
 *
 * Replaces fixed `sleep N; check; sleep N; check ...` loops with a single
 * tool call that polls a shell condition until it exits 0 (or times out).
 *
 * The condition is any shell command: exit 0 = ready, non-zero = not yet.
 * This covers the two real wait patterns observed in session history:
 *   - background process finished:  poll({ command: "! kill -0 $PID" })
 *   - CI pipeline reached terminal: poll({ command: "glab api .../jobs | jq -e 'all(.status|IN(\"success\",\"failed\",\"skipped\"))'" })
 *   - file appeared:                poll({ command: "test -f dist/bundle.js" })
 *   - port listening:               poll({ command: "curl -sf http://localhost:8080/health" })
 *
 * The check runs in the session cwd with the session env (same as the bash
 * tool), so proxies, KUBECONFIG, PATH all carry over. Each check is abortable
 * via the agent AbortSignal (Esc), and the wait between checks is interruptible
 * too — cancelling during a sleep resolves immediately.
 *
 * Install: pi install ./pi-poll  (from ~/projects/pi-mypackage)
 *   Test:  pi -e ./index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type TextBlock = { type: "text"; text: string };
const text = (s: string): TextBlock => ({ type: "text", text: s });

const DEFAULT_INTERVAL_S = 2;
const DEFAULT_TIMEOUT_S = 300;
const MAX_TIMEOUT_S = 86_400; // 24h hard cap

export default function pollExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "poll",
    label: "Poll",
    description:
      "Poll a shell command until it exits 0 (ready) or times out. Replaces fixed `sleep` loops: returns as soon as the condition is met instead of waiting a fixed duration. " +
      "Use to wait on background processes (`! kill -0 $PID`), CI pipelines (`glab api ... | jq -e '...'`), files (`test -f path`), ports (`curl -sf host:port/health`). " +
      "The check runs in the session cwd with the session env, so proxies and PATH carry over.",
    promptSnippet: "Poll a shell condition until exit 0 instead of fixed sleeps",
    promptGuidelines: [
      "Use poll to wait for a background process, CI pipeline, port, or file instead of `sleep N; check; sleep N; check` loops.",
      "The `command` must exit 0 when ready (e.g. `! kill -0 $PID`, `test -f out.json`, `curl -sf localhost:8080/health`, `glab api .../jobs | jq -e 'all(.status|IN(\"success\",\"failed\"))'`).",
      "poll returns as soon as the condition passes — no wasted wait. Set `timeout` if the wait could be long; default is 300s.",
      "Avoid bare `grep`/`diff`/`helm` in the check command — rtk may intercept them and return false results. Use `test -f`, `curl`, `ps`, `kill -0`, or full paths (`/usr/bin/grep`) instead.",
    ],
    parameters: Type.Object({
      command: Type.String({
        description:
          "Shell command to run as the readiness check. Exit 0 = ready (stop polling, success). Non-zero = not ready yet, poll again after `interval`. " +
          "Runs in the session cwd with the session env. Examples: `! kill -0 43803`, `test -f dist/bundle.js`, `curl -sf http://localhost:3000/health`, `glab api projects/24248/pipelines/1423631/jobs | jq -e 'all(.[]; .status|IN(\"success\",\"failed\",\"skipped\"))'`.",
      }),
      interval: Type.Optional(
        Type.Number({
          description: `Seconds between checks. Default ${DEFAULT_INTERVAL_S}. Lower polls tighter but runs the check more often.`,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: `Maximum seconds to wait before giving up. Default ${DEFAULT_TIMEOUT_S}.`,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const command = params.command?.trim();
      if (!command) {
        return {
          content: [text("Error: `command` is required.")],
          details: { ready: false },
        };
      }
      const intervalS = clampPositive(params.interval, DEFAULT_INTERVAL_S);
      const timeoutS = clampPositive(params.timeout, DEFAULT_TIMEOUT_S);
      if (timeoutS > MAX_TIMEOUT_S) {
        return {
          content: [text(`Error: timeout exceeds the ${MAX_TIMEOUT_S}s hard cap.`)],
          details: { ready: false },
        };
      }

      const cwd = ctx?.cwd ?? process.cwd();
      const ops = createLocalBashOperations();
      const deadline = Date.now() + timeoutS * 1000;
      const startedAt = Date.now();
      let attempts = 0;
      let lastOutput = "";
      let lastExitCode: number | null = null;

      const elapsedMs = () => Date.now() - startedAt;
      const remainingMs = () => deadline - Date.now();

      const report = (note: string) => {
        onUpdate?.({
          content: [text(`poll: attempt ${attempts} | elapsed ${(elapsedMs() / 1000).toFixed(1)}s | ${note}`)],
          details: null,
        });
      };

      report("starting");

      // Interruptible sleep: resolves early on abort so Esc cancels mid-wait.
      const sleepInterruptible = (ms: number): Promise<"ok" | "aborted"> =>
        new Promise((resolve) => {
          if (signal?.aborted) return resolve("aborted");
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve("ok");
          }, ms);
          const onAbort = () => {
            clearTimeout(timer);
            resolve("aborted");
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });

      try {
        while (true) {
          if (signal?.aborted) throw new Error("aborted");
          if (Date.now() >= deadline) {
            report("timed out");
            return timedOut({ command, attempts, elapsedMs: elapsedMs(), lastOutput, lastExitCode, intervalS });
          }

          attempts++;
          // Collect stdout+stderr of this check so the caller can see why it
          // failed (or the readiness evidence on success).
          const chunks: Buffer[] = [];
          let exitCode: number | null;
          try {
            const result = await ops.exec(command, cwd, {
              onData: (data) => chunks.push(data),
              signal,
              timeout: Math.min(30, Math.ceil(remainingMs() / 1000)) || 1,
            });
            exitCode = result.exitCode;
          } catch (err) {
            // aborted mid-check
            if (signal?.aborted) throw new Error("aborted");
            // treat exec error as "not ready yet" with the error as output
            exitCode = null;
            chunks.push(Buffer.from(String((err as Error)?.message ?? err)));
          }
          lastExitCode = exitCode;
          lastOutput = Buffer.concat(chunks).toString("utf8").trimEnd();

          if (exitCode === 0) {
            const msg = `poll: ready after ${attempts} attempt(s) in ${(elapsedMs() / 1000).toFixed(1)}s`;
            const content: TextBlock[] = [text(msg)];
            if (lastOutput) content.push(text(lastOutput));
            return {
              content,
              details: { ready: true, attempts, elapsedMs: elapsedMs(), exitCode, output: lastOutput },
            };
          }

          report(`not ready (exit ${exitCode ?? "?"})`);

          // Wait before next check, but not past the deadline.
          const wait = Math.min(intervalS * 1000, remainingMs());
          if (wait <= 0) {
            report("timed out");
            return timedOut({ command, attempts, elapsedMs: elapsedMs(), lastOutput, lastExitCode, intervalS });
          }
          const slept = await sleepInterruptible(wait);
          if (slept === "aborted") throw new Error("aborted");
        }
      } catch (err) {
        if ((err as Error)?.message === "aborted") {
          return {
            content: [text(`poll: aborted after ${attempts} attempt(s) in ${(elapsedMs() / 1000).toFixed(1)}s`)],
            details: { ready: false, aborted: true, attempts, elapsedMs: elapsedMs(), exitCode: lastExitCode, output: lastOutput },
          };
        }
        throw err;
      }
    },
  });
}

function clampPositive(v: number | undefined, fallback: number): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return fallback;
  return v;
}

function timedOut(args: {
  command: string;
  attempts: number;
  elapsedMs: number;
  lastOutput: string;
  lastExitCode: number | null;
  intervalS: number;
}) {
  const { command, attempts, elapsedMs, lastOutput, lastExitCode } = args;
  const msg =
    `poll: timed out after ${(elapsedMs / 1000).toFixed(1)}s (${attempts} attempt(s)). Condition never exited 0:\n  $ ${command}\n` +
    `last exit code: ${lastExitCode ?? "n/a"}`;
  const content: TextBlock[] = [text(msg)];
  if (lastOutput) content.push(text(lastOutput));
  return {
    content,
    details: {
      ready: false,
      timedOut: true,
      attempts,
      elapsedMs,
      exitCode: lastExitCode,
      output: lastOutput,
    },
  };
}
