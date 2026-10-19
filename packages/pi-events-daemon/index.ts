/**
 * pi-events-daemon — package entry point (deep-module layout: packages/README.md).
 *
 * Public surface = ROOT FILES only: one small entry per module (<module>.ts),
 * plus this aggregate for `import * as daemon` convenience — index.ts is no
 * longer the only public face. Each root file re-exports its module entry;
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
export * as protocol from "./protocol.ts";
export * as domain from "./domain.ts";
export * as store from "./store.ts";
export * as kernel from "./kernel.ts";
export * as profiles from "./profiles.ts";
export * as prober from "./prober.ts";
export * as transcriptAdapter from "./transcript-adapter.ts";
export * as loops from "./loops.ts";
export * as fx from "./fx.ts";
export * as transport from "./transport.ts";
export * as daemonMain from "./daemon-main.ts";
