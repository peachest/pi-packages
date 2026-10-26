// Node-level test for the wt remove self-guard pre-flight (#139) and the
// invocation parsing that feeds it. Run: node tests/remove-self-guard.test.mjs
import { register } from "node:module";
import { homedir } from "node:os";
import assert from "node:assert/strict";

register("./stub-loader.mjs", import.meta.url);
const { removeTargetsSelf, removeSelfGuardDecision, parseWtInvocation, normalizeDuplicatedVerb } = await import(
  "../upstream/worktrunk.ts"
);

const cwd = "/home/u/projects/repo-main";
const items = [
  { branch: "main", worktree: { path: "/home/u/projects/repo", main: true } },
  { branch: "repo-main", worktree: { path: cwd, current: true } },
  { branch: "feat-x", worktree: { path: "/home/u/projects/repo-feat-x" } },
];
const blocked = (args, extra = []) => removeTargetsSelf([...items, ...extra], args, cwd);

// Bare remove defaults to the current worktree -> always blocked.
assert.equal(blocked([]), true, "bare remove targets current worktree");
assert.equal(blocked(["-f"]), true, "flags-only remove still targets current worktree");
assert.equal(blocked(["-D", "--no-delete-branch"]), true, "flag combos too");

// Explicit current branch / path form / relative form -> blocked.
assert.equal(blocked(["repo-main"]), true, "remove current branch by name");
assert.equal(blocked(["."]), true, "remove '.' resolves to cwd");
assert.equal(blocked([cwd]), true, "remove current by absolute path");
assert.equal(blocked(["./"]), true, "remove current by relative path with slash");
const homeCwd = `${homedir()}/projects/repo-main`;
const homeItems = [
  ...items.filter((item) => item.branch !== "repo-main"),
  { branch: "repo-main", worktree: { path: homeCwd, current: true } },
];
assert.equal(
  removeTargetsSelf(homeItems, ["~/projects/repo-main"], homeCwd),
  true,
  "tilde path form",
);
assert.equal(blocked(["repo-main", "feat-x"]), true, "one self target blocks the batch");

// Ancestor of cwd -> blocked.
assert.equal(
  blocked(["x"], [{ branch: "x", worktree: { path: "/home/u/projects" } }]),
  true,
  "target is an ancestor directory of cwd",
);

// Discovery failure (rolling-r2 #1): list === undefined models client.list() throwing.
// Explicit targets must fail closed; bare remove keeps blocking via the cwd fallback.
const listFailure = removeSelfGuardDecision(undefined, ["repo-main"], cwd);
assert.equal(typeof listFailure, "string", "discovery failure + explicit target: rejected");
assert.match(listFailure, /wt list/, "rejection points at wt list verification");
assert.equal(
  removeSelfGuardDecision(undefined, [], cwd),
  removeSelfGuardDecision(items, ["repo-main"], cwd),
  "bare remove under discovery failure still blocks with the standard guard message",
);
assert.equal(
  removeSelfGuardDecision([], ["nope"], cwd),
  undefined,
  "known-empty list keeps historical fail-open for unknown branches (wt errors itself)",
);

// Other worktrees / unknown branches -> not blocked (wt handles those itself).
assert.equal(blocked(["feat-x"]), false, "removing another worktree is allowed");
assert.equal(blocked(["nope"]), false, "unknown branch: fail-open, wt errors on it");
assert.equal(blocked(["main"]), false, "removing the main checkout is not self-removal");
assert.equal(
  blocked(["y"], [{ branch: "y", worktree: { path: `${cwd}-suffix` } }]),
  false,
  "path prefix without directory boundary is not an ancestor",
);

// Non-remove commands are never guarded.
assert.equal(removeTargetsSelf(items, ["repo-main"], cwd) === true, true);
const other = parseWtInvocation("list --full");
assert.equal(other.command, "list");

// The real parser feeds commandArgs to the guard.
const inv = parseWtInvocation("remove -D feat-x");
assert.equal(inv.command, "remove");
assert.deepEqual(inv.commandArgs, ["-D", "feat-x"]);
assert.equal(blocked(inv.commandArgs), false);
const invSelf = parseWtInvocation("remove repo-main");
assert.equal(blocked(invSelf.commandArgs), true);

// homedir-based fixture sanity (tilde expansion used the real home).
assert.equal(
  blocked(["~/nowhere"], [
    { branch: "z", worktree: { path: `${homedir()}/nowhere` } },
  ]),
  false,
);

// Verb normalization: models composing the CLI string duplicate the verb into
// args[0]; the tool strips it instead of failing (2026-10-22 peer 01a1626a hit
// it 3x in one session).
assert.deepEqual(normalizeDuplicatedVerb("remove", ["remove", "ci/x"]), ["ci/x"], "duplicated verb stripped");
assert.deepEqual(normalizeDuplicatedVerb("switch", ["switch", "-c", "x"]), ["-c", "x"], "switch duplication too");
assert.deepEqual(normalizeDuplicatedVerb("remove", ["ci/x"]), ["ci/x"], "no duplication: unchanged");
assert.deepEqual(normalizeDuplicatedVerb("remove", ["-D", "ci/x"]), ["-D", "ci/x"], "flags first: unchanged");
assert.deepEqual(normalizeDuplicatedVerb("step", ["commit"]), ["commit"], "step subcommand unchanged");
assert.deepEqual(normalizeDuplicatedVerb("weird-alias", ["weird-alias", "x"]), ["weird-alias", "x"], "unknown verb not stripped (positional arg could be legit)");

console.log("remove-self-guard: all assertions passed");
