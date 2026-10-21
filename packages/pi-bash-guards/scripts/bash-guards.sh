#!/usr/bin/env bash
# pi-hooks custom guard: AGENTS.md never-do rules, enforced at tool level.
# Registered in ~/.pi/agent/kendex/hooks.json (tool_call listener, matcher "Bash").
#
# Evidence (session mining 2026-09-15, ~/tmp/mine-hook-candidates.py,
# 2369 sessions): docker-in-command-position 353 calls/77 sessions,
# git worktree add 139/63, whole-command bare cd 49/38,
# git commit --no-verify 17/7.
#
# 2026-10-20 extension (four-round mining, ~/tmp/hook-mining/): layered
# guards. The layer comes from the transcript_path slug directory: sessions
# under ~/projects get the projects guards (P1 secrets, P2 git add -A,
# P3 long sleep, P6 commit identity); every session gets the global ones
# (the original four below, plus G1 no hand-copying into the pi agent dir).
# Spec: ~/tmp/hook-mining/hook-candidates-full.md. Backup of the pre-
# extension script: ~/tmp/hook-mining/bash-guards.sh.bak-20261020.
#
# 2026-10-21 packaged: canonical source moved into pi-mypackage
# (packages/pi-bash-guards/scripts/bash-guards.sh, branch feat/pi-bash-guards).
# This file is a SYNC TARGET — edit the package source, then run
# `npm run sync` in packages/pi-bash-guards (or scripts/install.sh) to
# publish here. Do not hand-edit; hand edits are overwritten on next sync.
# Evidence archives & test fixtures historically under ~/tmp/hook-mining/
# now live in the package: tests/fixtures/*.sh. P1 credential detection
# moved to the pi-secret-store extension (#124, 2026-10-20) — not here.
#
# Verdicts (Claude Code convention this extension reads): exit 2 + stderr
# blocks the call with that reason; exit 0 allows.

read -r payload
python3 - "$payload" <<'PY'
import json, os, re, shlex, subprocess, sys

try:
    payload = json.loads(sys.argv[1])
    cmd = (payload.get("tool_input") or {}).get("command", "")
except Exception:
    sys.exit(0)  # unreadable payload: never block on our own parsing bug

def block(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)

# Layer: the transcript lives at ~/.pi/agent/sessions/<slug>/<file>.jsonl and
# the slug dir encodes the session cwd. No transcript or odd shape -> global
# only (fewer false blocks beats wider coverage).
transcript = payload.get("transcript_path", "")
in_projects = "--mnt-disk1-hyx-projects" in os.path.basename(os.path.dirname(transcript))

code = [l.strip() for l in cmd.split("\n") if l.strip() and not l.strip().startswith("#")]
code = [re.sub(r"^rtk\s+", "", l) for l in code]  # rtk wraps every bash command on this host
cmd = re.sub(r"^rtk\s+", "", cmd)

# pi-secret-store injects a sourcing prefix before the command
# (`: __PI_SECRET_STORE__; if [ -f … ]; then …; fi; <cmd>`). Strip it so the
# line-anchored checks below (bare cd, G1) see the command the agent wrote.
# Works regardless of listener order: absent marker = no-op; if the injected
# shape ever changes and this stops matching, the marker check above still
# keeps the original four guards intact.
if "__PI_SECRET_STORE__" in cmd:
    cmd = re.sub(r"^:\s*__PI_SECRET_STORE__\s*;.*?\bfi\s*;\s*", "", cmd, count=1, flags=re.S)
    code = [l.strip() for l in cmd.split("\n") if l.strip() and not l.strip().startswith("#")]

# Override escape hatch (#138): an explicit marker comment in the command
# text bypasses ALL guards for this one invocation, with a stderr warning as
# the audit trail. Guards must never permanently block legitimate rescue
# work; misuse of the marker still leaves this line behind.
if re.search(r"#\s*guard-override\b", cmd):
    print("guard-override: explicit marker found — guards bypassed for this "
          "command (audit trail).", file=sys.stderr)
    sys.exit(0)

# ---- global guards (every session cwd) ----

# 1. Whole command is a bare cd — a no-op, bash tool uses a fresh shell.
if code and all(re.fullmatch(r"cd(\s+\S+)?", l) for l in code):
    block("bare `cd <dir>` is a no-op: the bash tool runs each command in a "
          "fresh shell, so the working directory does not persist. "
          "Re-run as: (cd <dir> && <command>) — e.g. "
          "(cd /mnt/disk1/hyx/projects/HAMi && git status) — or use absolute paths.")

# 2. docker in command position — use sudo nerdctl (AGENTS.md).
#    Probes (which/grep/systemctl/…) are allowed; only running docker blocks.
PROBE = r"^(which|type|command\s+-v|whereis|grep|egrep|rg|ls|cat|tail|head|less|systemctl|journalctl|apt|apt-get|dpkg|nix|snap|find|stat)\b"
for l in code:
    for seg in re.split(r"[|;()&]+", l):          # command positions in the line
        s = seg.strip()
        if re.match(r"^(ssh|scp|rsync)\b", s):
            continue  # remote segment: quoted remote args (e.g. ssh host
            # 'docker ps') mis-split below, and remote hosts manage their own
            # docker — AGENTS.md rule is local-only. Later segments still scan.
        s = re.sub(r"^(?:\w+=\S*\s+)+", "", s)   # env-var prefix
        s = re.sub(r"^sudo\s+", "", s)
        if not s or re.match(PROBE, s):
            continue
        if re.match(r"^docker(\s|$)", s):
            block("docker is forbidden on this node (AGENTS.md). "
                  "Re-run with nerdctl, same subcommand: `sudo nerdctl "
                  + s[len("docker"):].strip() + "` — e.g. docker pull X → "
                  "sudo nerdctl pull X. Images/containers are managed via "
                  "sudo nerdctl; base images auto-pull to the buildkit namespace.")

# 3. Raw worktree creation — wt owns worktree lifecycle (AGENTS.md).
if re.search(r"\bgit\s+worktree\s+add\b", cmd):
    block("raw `git worktree add` is forbidden (AGENTS.md): worktrees are "
          "managed by wt, which computes sibling paths (~/projects/<repo>-"
          "<branch-slug>) and runs dependency hooks. Re-run as: "
          "`wt switch -c <branch>` — e.g. wt switch -c feat/x. Removal: "
          "wt remove <branch>, never delete the directory by hand.")

# ---- R1-R4: worktree lifecycle guards (#138, spec #137) ----
# Matching discipline (spec #137 lesson): first-token-sequence anchored at
# command positions only — never full-text substring. Rule 3 above matches
# full-text and false-blocked heredoc document bodies twice during the spec
# #137 creation (the body quoted the command literal); these rules must not
# repeat that. Known limit: single-token global opts before the subcommand
# (`git --git-dir=x worktree remove`) escape the pair-form opt skip — upgrade
# if ever seen in the wild.

def _wt_lines(text):
    # Lines with heredoc BODIES removed: body lines are document text, not
    # commands. The opener line is kept (it is a real command). Fail-open
    # direction only: a quoted "<<" in a non-heredoc line can fake a delimiter
    # and hide later lines from these rules — missed block, never false block.
    out, delim = [], None
    for raw in text.split("\n"):
        if delim is not None:
            if raw.strip() == delim:
                delim = None
            continue
        m = re.search(r"(?<!\S)<<-?\s*(['\"]?)([A-Za-z_]\w*)\1", raw)
        if m:
            delim = m.group(2)
        out.append(raw)
    return out

def _wt_segments(text):
    # Command positions within each line (same segment model as guard 2),
    # after rtk-prefix strip, comment-line drop, env-prefix and sudo strip.
    segs = []
    for l in _wt_lines(text):
        l = re.sub(r"^rtk\s+", "", l.strip())
        if not l or l.startswith("#"):
            continue
        for seg in re.split(r"[|;()&]+", l):
            s = seg.strip()
            s = re.sub(r"^(?:\w+=\S*\s+)+", "", s)   # env-var prefix
            s = re.sub(r"^sudo\s+", "", s)
            if s:
                segs.append(s)
    return segs

# R1. Deleting/pruning worktrees by raw git — wt owns removal (it refuses to
# remove the worktree the session sits in; raw git happily self-deletes the
# cwd: MR !688 HAMi cleanup, 2026-10-21 fix-eda-scan-fixes — bash deleted its
# own cwd, spawn ENOENT, session stuck 2h).
for _s in _wt_segments(cmd):
    if re.match(r"^git\s+(?:-\S+\s+\S+\s+)*worktree\s+(?:remove|prune)(\s|$)", _s):
        block("raw `git worktree remove/prune` destroys worktrees without the "
              "safety checks wt has — twice this has deleted the directory a "
              "running session sat in (MR !688 HAMi cleanup; 2026-10-21 "
              "fix-eda-scan-fixes: bash deleted its own cwd → spawn ENOENT, "
              "session dead 2h). Re-run with wt: `wt remove <branch>` — e.g. "
              "`wt remove feat/x` (it refuses the worktree you are sitting "
              "in). If this is documentation quoting the command, rephrase "
              "the wording or base64 it — the guard reads command position "
              "only. Genuine rescue need: append `# guard-override: <reason>`.")

# R2. Merges by raw git bypass the merge discipline (pre-merge verify gate; a
# session that dies mid-merge leaves conflict state behind). Canonical paths:
# personal repos merge via the worktrunk tool; remote-already-merged syncs
# via pull --ff-only. The git pull family is fully allowed.
for _s in _wt_segments(cmd):
    if re.match(r"^git\s+(?:-\S+\s+\S+\s+)*merge(\s|$)", _s) \
            and not re.search(r"(^|\s)--ff-only(\s|$)", _s) \
            and not re.search(r"(^|\s)--(?:abort|continue|quit)(\s|$)", _s):
        block("raw `git merge` bypasses the merge discipline (pre-merge verify "
              "gate; sessions have died mid-merge leaving conflict state "
              "behind). Personal repos: merge with the worktrunk tool — "
              "`wt merge` (verify + merge + session migration). If the remote "
              "already contains the branch, sync instead: `git pull --ff-only` "
              "— e.g. `git pull --ff-only origin main`. Genuine rescue need: "
              "append `# guard-override: <reason>`.")

# R3. Cross-branch checkout inside a linked worktree strands the session (the
# worktree belongs to its branch; wt switch migrates the session along). The
# trigger is cwd-based: in a linked worktree .git is a FILE; a main checkout
# has a .git DIRECTORY and is never touched by this rule. File restores
# (checkout -- <path>, checkout <rev> -- <path>, checkout <existing path>)
# and new-branch creation (-b/-B/-c/-C/--orphan) stay allowed.
if os.path.isfile(".git"):
    for _s in _wt_segments(cmd):
        _m = re.match(r"^git\s+(?:-\S+\s+\S+\s+)*(checkout|switch)(\s|$)", _s)
        if not _m:
            continue
        try:
            _args = shlex.split(_s[_m.end():])
        except ValueError:
            _args = _s[_m.end():].split()
        _branch = None
        _i = 0
        while _i < len(_args):
            _a = _args[_i]
            if _a == "--":
                break  # pathspec from here on: file restore
            if _a in ("-b", "-B", "-c", "-C", "--orphan"):
                break  # new branch in this tree: allowed
            if _a in ("-t", "--track"):
                _i += 2
                continue
            if _a.startswith("-"):
                _i += 1
                continue
            _branch = _a
            break
        if _branch is None or ("--" in _args and _m.group(1) == "checkout"):
            continue
        if _m.group(1) == "checkout" and os.path.exists(_branch):
            continue  # bare <path> restore — the path exists in this tree
        block("`git checkout <branch>`/`git switch <branch>` inside a linked "
              "worktree moves this tree off its branch and strands the "
              "session (processes anchored to the old branch break — same "
              "class as the !688 / 2026-10-21 cwd-deletion incidents). "
              "Re-run with wt: `wt switch <branch>` — e.g. `wt switch main` "
              "— which migrates the session with the checkout. File restores "
              "(`git checkout -- <path>`) and new branch creation "
              "(`git checkout -b <name>`) stay allowed. Genuine rescue need: "
              "append `# guard-override: <reason>`.")

# R4. wt merge -y/--yes skips the approval prompt — merging is the user's
# decision (AGENTS.md); headless workers report the pending merge to the
# parent instead of approving it themselves.
for _s in _wt_segments(cmd):
    if re.match(r"^wt\s+merge(\s|$)", _s) and re.search(r"(^|\s)(-y|--yes)(\s|$)", _s):
        block("`wt merge -y/--yes` auto-approves the merge — merge approval is "
              "the user's decision (AGENTS.md), not the agent's. Re-run "
              "without -y/--yes and answer the prompt (`wt merge`), or stop "
              "and report the pending merge to the parent/user session for "
              "approval (headless convention: `wt merge --no-remove` + "
              "report, never -y). Genuine rescue need: append "
              "`# guard-override: <reason>`.")

# 4. Skipping repo hooks: commit --no-verify|-n, push --no-verify.
#    (git push -n means --dry-run, NOT --no-verify — do not blanket-match -n.)
if re.search(r"\bgit\s+(?:-\S+\s+\S+\s+)*commit(\s|$)", cmd) and re.search(r"(^|\s)(--no-verify|-n)(\s|$)", cmd):
    block("git commit --no-verify skips repo hooks (AGENTS.md never-do). "
          "Drop the --no-verify/-n flag. If a hook fails, run it manually "
          "to see the error (e.g. bash .git/hooks/pre-commit) and fix the "
          "reported issue instead of bypassing validation.")
if re.search(r"\bgit\s+push\b", cmd) and re.search(r"(^|\s)--no-verify(\s|$)", cmd):
    block("git push --no-verify skips pre-push guards (e.g. the gitleaks "
          "secret scan in ~/skills). Drop --no-verify. To see what the hook "
          "would flag before pushing, run: gitleaks git --log-opts "
          "'origin/main..HEAD' -c ~/data/benchmark/config/gitleaks.toml . "
          "— fix any finding, then push normally.")

# G1. Hand-copying into the pi agent dirs (global: the agent install lives
# outside any one project). Mining: 14 commands/11 sessions, all in
# pi-mypackage sessions; root AGENTS.md forbids it with zero enforcement.
# Guarded targets: ~/.pi/agent/extensions (extensions) and ~/.agents/skills
# (npx skill chain install point; ~/.pi/agent/skills was retired 2026-10-15,
# kept in the pattern to catch the old habit). Only the COPY DESTINATION is
# judged — the last non-flag argument of ln/cp — so reading from the install
# dir (cp ~/.agents/skills/x/SKILL.md ~/tmp/) stays legal. Both sanctioned
# channels go through installers, never ln/cp:
#   skills:   edit ~/skills source -> commit (post-commit hook reinstalls)
#   packages: edit ~/skills extensions + package.json manifest -> pi install
import shlex
for l in code:
    if not re.match(r"^(ln|cp)\s", l):
        continue
    try:
        argv = shlex.split(l)[1:]
    except ValueError:
        argv = l.split()[1:]
    # rolling-r1 L279: -t/--target-directory redirects the destination; the
    # generic flag filter dropped it and judged a source argument instead.
    target_dir = None
    positional = []
    _i = 0
    while _i < len(argv):
        _a = argv[_i]
        if _a in ("-t", "--target-directory") and _i + 1 < len(argv):
            target_dir = argv[_i + 1]
            _i += 2
            continue
        if _a.startswith("--target-directory="):
            target_dir = _a.split("=", 1)[1]
            _i += 1
            continue
        if not _a.startswith("-"):
            positional.append(_a)
        _i += 1
    dest = target_dir or (positional[-1] if positional else "")
    if not dest:
        continue
    if re.search(r"(\.pi/agent/(extensions|skills)|\.agents/skills)(/|\s|['\"]|$)", dest):
        block("placing files into ~/.pi/agent/extensions or ~/.agents/skills by "
              "hand is forbidden (AGENTS.md) — installs drift and shadow the "
              "managed copies. Channels: skills -> edit the ~/skills source repo "
              "and commit (post-commit reinstall runs for you); extensions/pi "
              "packages -> edit ~/skills/extensions + package.json manifest, "
              "then `pi install /mnt/disk1/hyx/skills`; third-party packages -> "
              "`pi install npm:<name>`. If you only meant to READ from the "
              "install dir, copy from it into ~/tmp instead — that stays allowed "
              "(only the destination is guarded).")

# ---- projects guards (session cwd under ~/projects) ----

if in_projects:
    # P1 (credential fingerprints) moved 2026-10-20 into the pi-secret-store
    # package (tool_call listener inside the extension, checked before env
    # injection): peachest/pi-packages#124. This file no longer owns it.
    # P2. git add -A / --all / . — stage files explicitly (AGENTS.md repo
    # rule; 15 repos, ~960 calls mined).
    if re.search(r"\bgit\s+add\s+(?:-\S*\s+)*(?:-A\b|--all\b|\.(?:\s|$))", cmd):
        block("`git add -A/-a-all/.` stages everything including other "
              "sessions' in-progress work — AGENTS.md requires staging only "
              "this task's files. Re-run with explicit paths: `git add "
              "<file1> <file2>` (find them with `git status --short`), or "
              "`git add -u` to stage modifications of already-tracked files "
              "only.")

    # P3. Foreground sleep >= 60s parks the whole turn (14 repos, ~700 calls,
    # tens of hours of wall clock; near-zero bg adoption). Nudge, don't
    # block: exit 2 with a redirect is the nudge channel pi-hooks gives us.
    for m in re.finditer(r"\bsleep\s+(\d+)([smh]?)\b", cmd):
        n, unit = int(m.group(1)), m.group(2)
        seconds = n * {"": 1, "s": 1, "m": 60, "h": 3600}[unit]
        if seconds >= 60:
            block(f"foreground `sleep {m.group(1)}{unit}` parks this whole turn "
                  f"for {seconds}s while nothing else can happen. Long waits "
                  f"should be event-driven: use the pi-events-daemon tools "
                  f"(`subscribe` with a check/entity — it wakes this session "
                  f"on completion), or `bg_run` for one-shot background "
                  f"commands. Genuine short backoff: keep it under 60s or "
                  f"split into repeated short sleeps around real work.")

    # P6. Commit identity must match the repo's remote platform (pi-arena: 35
    # commits one day split across two identities; base-charts: 4/5 commits
    # with the wrong author, fixed by history rewrite).
    #
    # Multi-remote repos (ascend-device-plugin family: origin=github fork,
    # push target=internal gitblue): a single-remote origin lookup is a false
    # positive generator. Two mechanisms:
    #   a) push-remote resolution chain: branch.<cur>.pushRemote →
    #      remote.pushDefault → origin;
    #   b) allow when the configured email matches the expected identity of
    #      ANY configured remote — a repo-local user.email is a deliberate
    #      choice, only an email matching NO remote's platform blocks.
    if re.search(r"\bgit\s+(?:-\S+\s+\S+\s+)*commit(\s|$)", cmd) and not re.search(r"(^|\s)(--no-verify|-n)(\s|$)", cmd):
        inline = re.search(r"user\.email[= ]\s*[\"']?([^\"'\s;&|]+)", cmd)
        try:
            email = subprocess.run(["git", "config", "user.email"], capture_output=True,
                                   text=True, timeout=5).stdout.strip()
        except Exception:
            email = ""
        expected = {"gitblue": "yuxi.hou@transwarp.io", "transwarp": "yuxi.hou@transwarp.io",
                    "github": "1938913473@qq.com"}
        DEFAULT_EMAIL = "yuxi.hou@transwarp.io"
        try:
            remotes = subprocess.run(["git", "remote", "-v"], capture_output=True,
                                     text=True, timeout=5).stdout
        except Exception:
            remotes = ""
        remote_urls = sorted({m.group(1).lower() for m in re.finditer(r"^\S+\s+(\S+)\s+\(fetch\)$", remotes, re.M)})
        want_any = {v for url in remote_urls for k, v in expected.items() if k in url}
        if remote_urls:
            # push-remote resolution chain, for naming the platform in the message
            branch = subprocess.run(["git", "branch", "--show-current"], capture_output=True,
                                    text=True, timeout=5).stdout.strip()
            push_remote = subprocess.run(["git", "config", f"branch.{branch}.pushRemote"],
                                         capture_output=True, text=True, timeout=5).stdout.strip() \
                or subprocess.run(["git", "config", "remote.pushDefault"], capture_output=True,
                                  text=True, timeout=5).stdout.strip() or "origin"
            push_url = next((u for u in remote_urls if push_remote and push_remote in
                             {r.group(1) for r in re.finditer(rf"^{re.escape(push_remote)}\s+(\S+)\s+\(fetch\)$", remotes, re.M)}),
                            remote_urls[0])
            platform = next((k for k in expected if k in push_url), push_remote or "the default")
        else:
            platform = "the default"
            want_any = {DEFAULT_EMAIL}  # no remote: default identity is the only match
        suggest = next(iter(sorted(want_any)), DEFAULT_EMAIL)
        # A command that first sets config, then commits, must set a matching one.
        if inline and inline.group(1) not in want_any:
            block(f"git -c user.email={inline.group(1)} matches no remote platform "
                  f"of this repo ({platform} is the push target; expected "
                  f"{', '.join(sorted(want_any))}). Commit with the matching identity.")
        if not inline and email not in want_any:
            block(f"committing as {email or '(no email configured)'} — matches no "
                  f"remote platform of this repo ({platform} is the push target; "
                  f"expected {', '.join(sorted(want_any))}) — "
                  f"mixed identities forced a history rewrite once already "
                  f"(pi-arena, 35 commits in two identities). Fix first: "
                  f"`git config user.email {suggest}` (repo-local), or "
                  f"commit with `git -c user.email={suggest} commit …`.")

sys.exit(0)
PY
