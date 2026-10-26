// Node-level test for the wt merge direction guard (2026-10-26 c2 incident):
// `wt merge <TARGET>` squashes the CURRENT branch INTO TARGET; running it from the
// main checkout with another worktree's branch as TARGET reverses the direction.
// Run: node tests/merge-direction-guard.test.mjs
import { register } from "node:module";
import assert from "node:assert/strict";

register("./stub-loader.mjs", import.meta.url);
const { mergeDirectionGuardDecision, parseWtInvocation } = await import(
  "../upstream/worktrunk.ts"
);

const cwd = "/home/u/projects/repo"; // the main checkout
const items = [
  { branch: "main", worktree: { path: cwd, main: true, current: true } },
  { branch: "feat-c2", worktree: { path: "/home/u/projects/repo-feat-c2" } },
  { branch: "wt-guardrails", worktree: { path: "/home/u/projects/repo-wt-guardrails" } },
];

// The incident shape: main checkout, explicit TARGET = another live worktree's branch.
const msg = mergeDirectionGuardDecision(items, ["feat-c2"], cwd);
assert.equal(typeof msg, "string", "reversed merge from main checkout is blocked");
assert.match(msg, /feat-c2/, "message names the target branch");
assert.match(msg, /wt -C /, "message gives the -C fix");

// Main checkout on a feature branch (main worktree, current branch != TARGET).
const parked = [
  { branch: "wt-guardrails", worktree: { path: cwd, main: true, current: true } },
  { branch: "feat-c2", worktree: { path: "/home/u/projects/repo-feat-c2" } },
];
assert.match(
  mergeDirectionGuardDecision(parked, ["feat-c2"], cwd),
  /反向合进/,
  "main checkout parked on another line still blocks",
);

// Not blocked: bare merge (TARGET defaults to main), non-main checkouts,
// TARGET == current branch, TARGET without a live worktree, discovery failure.
assert.equal(mergeDirectionGuardDecision(items, [], cwd), undefined, "bare merge untouched");
assert.equal(mergeDirectionGuardDecision(items, ["--no-squash"], cwd), undefined, "flags-only merge untouched");
assert.equal(
  mergeDirectionGuardDecision(
    [{ branch: "feat-c2", worktree: { path: cwd, current: true } }, ...items.filter((i) => i.branch !== "main")],
    ["main"],
    cwd,
  ),
  undefined,
  "feature checkout merging into main untouched",
);
assert.equal(
  mergeDirectionGuardDecision(items.filter((i) => !i.worktree?.main).map((i) => ({ ...i, worktree: { ...i.worktree, current: i.branch === "feat-c2" } })), ["wt-guardrails"], cwd),
  undefined,
  "linked-worktree stacked merge (feat-c2 -> wt-guardrails) untouched",
);
assert.equal(mergeDirectionGuardDecision(items, ["main"], cwd), undefined, "TARGET == current branch: wt errors itself");
assert.equal(mergeDirectionGuardDecision(items, ["orphan"], cwd), undefined, "unknown TARGET branch fails open");
assert.equal(mergeDirectionGuardDecision(undefined, ["feat-c2"], cwd), undefined, "discovery failure fails open (reversed merge is abort-recoverable)");

// Flags with -C discovery are stripped before target matching: `wt -C <dir> merge feat-c2`
// runs IN feat-c2's repo — from there current is feat-c2's checkout, not the main one.
const inv = parseWtInvocation("-C /home/u/projects/repo-feat-c2 merge feat-c2");
assert.equal(inv.command, "merge");
const c2Items = [
  { branch: "main", worktree: { path: "/home/u/projects/repo", main: true } },
  { branch: "feat-c2", worktree: { path: "/home/u/projects/repo-feat-c2", current: true } },
];
const targetArgs = inv.commandArgs.filter((arg, i, arr) => arg !== "-C" && !(i > 0 && arr[i - 1] === "-C"));
assert.deepEqual(targetArgs, ["feat-c2"], "-C pair stripped from targets");
assert.equal(
  mergeDirectionGuardDecision(c2Items, targetArgs, cwd),
  undefined,
  "-C into the feature checkout is the correct fix and is not blocked",
);

// The real parser feeds the guard (duplicated-verb shape too).
const inv2 = parseWtInvocation("merge wt-guardrails");
assert.equal(inv2.command, "merge");
assert.match(mergeDirectionGuardDecision(items, inv2.commandArgs, cwd), /wt-guardrails/);

console.log("merge-direction-guard: all assertions passed");
