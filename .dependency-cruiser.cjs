// @ts-check
// Deep-module enforcement for dependency-cruiser.
//
// Each package under the packages root is a DEEP MODULE: a lot of behaviour
// behind a small interface. A package's PUBLIC SURFACE is its ENTRY POINTS:
// the files at the package root. Implementation lives in SUBFOLDERS and is
// private (by convention `lib/` for implementation and `tests/` for tests,
// though any subfolder is private). A package may expose several small entry
// points (index.ts, client.ts, server.ts, …); prefer that over one giant
// barrel index.
//
// Source: setup-ts-deep-modules skill. PACKAGES_ROOT is the only repo-specific edit.

/** Where packages live. One immediate child dir per package (flat, no nesting). */
const PACKAGES_ROOT = "packages";

// --- derived patterns (no need to edit) -------------------------------------
const R = PACKAGES_ROOT;
const PACKAGE_INTERNALS = `^${R}/[^/]+/[^/]+/`;

/** Vendored upstream copies (built JS from other repos) — not part of any package's own graph. */
const UPSTREAM = `^${R}/[^/]+/upstream/`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "entrypoint-boundary-from-app",
      comment:
        "App/root code may import a package's entry points (its root files), but nothing inside its subfolders.",
      severity: "error",
      from: { pathNot: `^${R}/` },
      to: { path: PACKAGE_INTERNALS },
    },
    {
      name: "entrypoint-boundary-across-packages",
      comment:
        "A package's own files import each other freely, but may reach OTHER packages only through their entry points, never their internals.",
      severity: "error",
      from: { path: `^${R}/([^/]+)/`, pathNot: `^${R}/[^/]+/tests/` },
      to: {
        path: PACKAGE_INTERNALS,
        pathNot: `^${R}/$1/`,
      },
    },
    {
      name: "tests-through-entrypoints",
      comment:
        "A package's tests exercise it through its entry points like everyone else: they may import any package's entry points and their own tests/ fixtures, but never any package's internals, not even their own.",
      severity: "error",
      from: { path: `^${R}/([^/]+)/tests/` },
      to: {
        path: PACKAGE_INTERNALS,
        pathNot: `^${R}/$1/tests/`,
      },
    },
    {
      name: "tests-folder-is-private",
      comment:
        "A package's tests/ folder is reachable only from tests: nothing else may import fixtures.",
      severity: "error",
      from: { pathNot: `^${R}/[^/]+/tests/` },
      to: { path: `^${R}/[^/]+/tests/` },
    },
    {
      name: "no-circular",
      comment: "No dependency cycles.",
      severity: "error",
      from: {},
      to: { circular: true },
    },

    // --- pi-events-daemon 包内分层规则（ticket 01，融合架构 00-summary 依赖单向链）---
    // 模式：from 本模块 → to 其他模块即红（$1 反向引用自身模块允许自引）
    // 叶模块逐条规则（depcruise 的 pathNot 不支持跨 from/to 的 $1 反向引用，逐叶展开）
    ...["protocol", "fx", "domain", "store"].map((leaf) => ({
      name: `eda-leaf-zero-dep-${leaf}`,
      comment: `Zero-dep leaf ${leaf} imports nothing outside its own module (D3: store 与 domain 互不依赖).`,
      severity: "error",
      from: { path: `^${R}/pi-events-daemon/${leaf}/` },
      to: {
        path: `^${R}/pi-events-daemon/`,
        pathNot: `^${R}/pi-events-daemon/${leaf}/`,
      },
    })),
    {
      name: "eda-adapter-fx-only",
      comment: "prober / transcript-adapter 零上层依赖，只可用 fx 端口（自身内部自由；fx 在放行清单内，对齐票 01 DAG）。",
      severity: "error",
      from: { path: `^${R}/pi-events-daemon/(prober|transcript-adapter)/` },
      to: {
        path: `^${R}/pi-events-daemon/`,
        pathNot: `^${R}/pi-events-daemon/(prober|transcript-adapter|fx)/`,
      },
    },
    {
      name: "eda-a-layer-no-direct-io",
      comment:
        "A 层（loops/prober/transcript-adapter/daemon-main）禁直接 import node 内置 IO 模块——外部效应只经 fx 端口与 Store 接口（票 14）。fx/ 真壳 adapter 不在本规则 from 集内（真实现必须碰真系统）。合法 node 导入面为空：fx 是零依赖叶（eda-leaf-zero-dep-fx），端口类型只用原始值，A 层无任何正当 node: 引用。",
      severity: "error",
      from: {
        path: `^${R}/pi-events-daemon/(loops|prober|transcript-adapter|daemon-main)/`,
      },
      to: {
        path: `^(node:)?(fs|fs/promises|net|tls|dgram|dns|dns/promises|http|https|http2|child_process|tty|os|process|worker_threads)$`,
      },
    },
    {
      name: "eda-kernel-deps",
      comment: "kernel imports only domain + store（自身内部自由）。",
      severity: "error",
      from: { path: `^${R}/pi-events-daemon/kernel/` },
      to: {
        path: `^${R}/pi-events-daemon/`,
        pathNot: `^${R}/pi-events-daemon/(kernel|domain|store)/`,
      },
    },
    {
      name: "eda-profiles-type-only",
      comment: "profiles → kernel 单向（I-01/ADR 0005）；kernel 不得 import profiles。",
      severity: "error",
      from: { path: `^${R}/pi-events-daemon/kernel/` },
      to: { path: `^${R}/pi-events-daemon/profiles/` },
    },
    {
      name: "eda-profiles-deps",
      comment:
        "profiles from-set 完整约束（eda-profiles-type-only 的对偶）：profiles 只许 import kernel（类型，I-01/ADR 0005）+ 自身；禁 profiles→{protocol,domain,store,fx,prober,transcript-adapter,loops,transport,daemon-main}。",
      severity: "error",
      from: { path: `^${R}/pi-events-daemon/profiles/` },
      to: {
        path: `^${R}/pi-events-daemon/`,
        pathNot: `^${R}/pi-events-daemon/(profiles/|kernel/|kernel\.ts$)`,
      },
    },
    {
      name: "eda-loops-deps",
      comment: "loops → kernel / prober / transcript-adapter / fx / store / domain，禁止直达 transport / profiles / daemon-main。",
      severity: "error",
      from: { path: `^${R}/pi-events-daemon/loops/` },
      to: {
        path: `^${R}/pi-events-daemon/`,
        pathNot: `^${R}/pi-events-daemon/(loops|kernel|prober|transcript-adapter|fx|store|domain)/`,
      },
    },
    {
      name: "eda-transport-deps",
      comment: "transport → protocol only（薄 adapter 不长策略）。",
      severity: "error",
      from: { path: `^${R}/pi-events-daemon/transport/` },
      to: {
        path: `^${R}/pi-events-daemon/`,
        pathNot: `^${R}/pi-events-daemon/(transport|protocol)/`,
      },
    },
    {
      name: "eda-daemon-main-composition",
      // 票 40：规则意图 = 跨模块只经模块入口；daemon-main 模块内部文件（op-dispatch 等装配胶水）自洽放行
      comment: "daemon-main 组合根：跨模块只 import 各模块入口（index.ts），不得深入他模块内部；模块内部文件自洽。",
      severity: "error",
      from: { path: `^${R}/pi-events-daemon/daemon-main/` },
      to: {
        path: `^${R}/pi-events-daemon/[^/]+/`,
        pathNot: `^${R}/pi-events-daemon/(daemon-main/.+|[^/]+/index\\.ts)$`,
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // vendored 构建产物不进依赖图（票 #124：upstream/ 内 5 条 no-circular 假红）
    exclude: { path: "^packages/[^/]+/upstream/" },
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },
  },
};
