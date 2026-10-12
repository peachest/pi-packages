import type { Clock, Exec, ExecOptions, ExecResult } from "./types.ts";

/**
 * FakeClock——manual drive 行为契约（fx.md 钉死：手动推进、到期定时器按序触发后返回）。
 * step 同步触发全部到期定时器（按到期时刻、同刻按调度序），回调内新调度者若在推进终点前到期同样本步触发。
 */
export class FakeClock implements Clock {
  private time = 0;
  private nextSeq = 0;
  private timers: { due: number; seq: number; fn: () => void; cancelled: boolean }[] = [];

  now(): number {
    return this.time;
  }

  /** 未触发的定时器数——「parked 零副作用」类断言的观测面（spec31 fx:Effects）。 */
  get pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const timer = { due: this.time + Math.max(0, ms), seq: this.nextSeq++, fn, cancelled: false };
    this.timers.push(timer);
    return { cancel: () => void (timer.cancelled = true) };
  }

  /** 手动推进 ms 毫秒：到期定时器按序同步触发后返回。触发时虚拟时间走到该定时器的到期时刻（回调内 now() 与新调度均相对触发时刻），全部结算后 now() 停在推进终点。 */
  step(ms = 0): void {
    const target = this.time + Math.max(0, ms);
    for (;;) {
      const next = this.timers
        .filter((t) => !t.cancelled && t.due <= target)
        .sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (!next) break;
      this.timers.splice(this.timers.indexOf(next), 1);
      this.time = Math.max(this.time, next.due);
      next.fn();
    }
    this.time = target;
    this.timers = this.timers.filter((t) => !t.cancelled);
  }
}

/** FakeExec——脚本化响应序列（fx.md 钉死）：run 按入队次序逐个消费，partial 补平台原形默认值；耗尽即响亮失败。 */
export class FakeExec implements Exec {
  readonly calls: { command: string; opts: ExecOptions | undefined }[] = [];
  private readonly script: Partial<ExecResult>[] = [];

  /** 入队后续 run 的响应（按序消费）。 */
  enqueue(...results: Partial<ExecResult>[]): void {
    this.script.push(...results);
  }

  async run(command: string, opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ command, opts });
    const scripted = this.script.shift();
    if (!scripted) throw new Error(`FakeExec: script exhausted, unexpected run: ${command}`);
    return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...scripted };
  }
}
