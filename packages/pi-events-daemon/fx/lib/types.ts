/**
 * fx 端口类型——零实现 seam 集合（#31 fx:Effects 停点）。
 * 类型只用原始值（零业务泄漏）：fx 是零依赖叶（eda-leaf-zero-dep-fx 机器强制，不可能 import domain）。
 * update_hook 与第五停点（持久化写）不属 fx——Store 接口自身契约（store spec）。
 */

/** 时间与定时器：单增毫秒时钟 + 可取消定时。 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): { cancel(): void };
}

/**
 * 进程执行：shell 唯一判定原语（HTTP 经 `curl -sf`，无独立 HTTP 路径）。prober 唯一执行面。
 */
export interface Exec {
  run(command: string, opts?: ExecOptions): Promise<ExecResult>;
}

export interface ExecOptions {
  /** 超时杀进程；缺省不超时（10s 默认 / 300s 上限是 prober 执行面策略，不在 fx）。契约：timeoutMs 后 run 必结算（成功/失败/超时终止三选一）——实现须升级杀（ShellExec：SIGTERM 后宽限期 SIGKILL 整进程组），忽略 TERM 的 hung checker 不得挂死承诺。 */
  timeoutMs?: number;
  /** 叠加在 process.env 之上（no_proxy 全局注入等策略经此传入）。 */
  env?: Record<string, string>;
}

/** 平台原形：child_process 的 exitCode/signal 原样上抛（0=passed、2=failed 断言、其他=waiting 的归类属 prober）。 */
export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** socket 通知推送：L2 投递出口。push resolve = 实际送达数（成功写的连接数；0 = 无人收到，
 *  调用方不得迁移投递状态——票 38 评审 H：零客户端/写全败不假成功）；reject = 投递失败
 *  （fake 须镜像 close/reject 注入路径，票 13）。 */
export interface Pusher {
  push(line: string): Promise<number>;
}

/** 只读文件面（fx.md“文件读写”的收窄裁定：MVP 消费者全部只读——transcript-adapter 只读、daemon-main 配置读）：接口无写方法。watch 是观察非写（票 18 fs-watch 原生推送停点）。 */
export interface Fs {
  readFile(path: string): Promise<string>;
  /** 文件监听（fs.watch 薄包装，内核原生推送非轮询）：变更即调 onEvent（无事件载荷，命中过滤归消费方）；error 经 onError 上抛（缺省收尾 close，防未处理 error 崩进程），处理语义归消费方。句柄 close() 后回调不再触发（资源清理归调用方）。 */
  watch(path: string, onEvent: () => void, onError?: (err: unknown) => void): { close(): void };
}
