/**
 * pi-events-daemon — package entry point (deep-module layout: packages/README.md).
 *
 * Public surface = ROOT FILES only. Each module re-exports its own entry;
 * cross-module import direction is enforced by lint:boundaries (ticket 01).
 *
 * Dependency DAG (00-summary 融合架构):
 *   protocol, fx, domain, store  — zero-dep leaves (store: D3 自定形状, 不 import domain)
 *   kernel       → domain + store
 *   profiles     → kernel (types only, I-01)
 *   prober, transcript-adapter → fx
 *   loops        → kernel, prober, transcript-adapter, fx, store
 *   transport    → protocol
 *   daemon-main  → all module entries (composition root)
 */
export * as protocol from "./protocol/index.ts";
export * as domain from "./domain/index.ts";
export * as store from "./store/index.ts";
export * as kernel from "./kernel/index.ts";
export * as profiles from "./profiles/index.ts";
export * as prober from "./prober/index.ts";
export * as transcriptAdapter from "./transcript-adapter/index.ts";
export * as loops from "./loops/index.ts";
export * as fx from "./fx/index.ts";
export * as transport from "./transport/index.ts";
export * as daemonMain from "./daemon-main/index.ts";
