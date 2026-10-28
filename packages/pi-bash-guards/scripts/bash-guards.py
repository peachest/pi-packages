#!/usr/bin/env python3
''''exec python3 "$0" "$@" # '''
# pi-bash-guards — pi global behavior guards, pure python single-file engine
# (spec #142, ADR-0001). Registered in ~/.pi/agent/kendex/hooks.json as a
# tool_call listener (matcher "Bash", command `python3 <this file>`).
#
# Line 2 is the standard python/bash polyglot: bash (fixtures and any legacy
# `bash <file>` caller execute it as the exec builtin and replace the process
# with python3 — one process, no wrapper, no heredoc escaping); python sees a
# no-op string literal. It keeps the fixtures' `GUARD env → run file` test
# mechanism file-type agnostic, which is what made the bash shell removable.
#
# File layout (ADR-0001): three data partitions and a verdict driver.
#   ═══ PARSER ═══  payload in → normalized command text; the single parse
#                   seam is the segments()/pairs() pair (former _wt_segments/
#                   _wt_pairs, consolidated here so parser fixes land once).
#   ═══ RULES ═══   every guard is a declarative table entry
#                   {id, scope, matcher, message}; matcher is polymorphic —
#                   a regex string (engine anchors re.match at each segments()
#                   command position) or a callable(ctx) → params|None for
#                   rules needing state beyond the seam (cwd tracking, argv
#                   dest, git probes, full-text debt rules).
#   ═══ MESSAGES ═══ every verdict text as a template; dynamic messages are
#                   callables over the matcher's params. 14 entries carry 17
#                   verdicts: no-verify/G1/P6 each hold two messages whose
#                   selection is order-sensitive within one scan pass —
#                   splitting them into per-message rules would reorder which
#                   message fires first across segments (golden-locked).
#   ═══ VERDICT ═══ the engine: stdin JSON → exit 0 | exit 2 + stderr.
#
# Evidence (session mining 2026-09-15, ~/tmp/mine-hook-candidates.py, 2369
# sessions): docker-in-command-position 353 calls/77 sessions, git worktree
# add 139/63, whole-command bare cd 49/38, git commit --no-verify 17/7.
# 2026-10-20 extension (four-round mining, ~/tmp/hook-mining/): layered
# guards — the layer comes from the transcript_path slug directory: sessions
# under ~/projects get the projects guards (P2 git add -A, P3 long sleep, P6
# commit identity); every session gets the global ones. Spec:
# ~/tmp/hook-mining/hook-candidates-full.md; fixtures: tests/fixtures/*.sh.
# P1 credential detection moved to the pi-secret-store package (#124).
#
# This file in the package is the CANONICAL source; the copy under
# ~/.pi/agent/kendex/hooks/ is a sync target (scripts/install.sh). Verdict
# protocol (Claude Code hook convention): exit 2 + stderr blocks the call
# with that reason; exit 0 allows; unreadable payload → exit 0 (fail-open).

import io
import hashlib, json, os, re, shlex, subprocess, sys, time

# ═══ PARSER ═══

def parse_payload(stream):
    # stdin JSON → (cmd, code, in_projects, transcript); None when unreadable (fail-open:
    # never block on our own parsing bug).
    try:
        payload = json.loads(stream.read())
        cmd = (payload.get("tool_input") or {}).get("command", "")
    except Exception:
        return None
    # Layer: the transcript lives at ~/.pi/agent/sessions/<slug>/<file>.jsonl
    # and the slug dir encodes the session cwd. No transcript or odd shape ->
    # global only (fewer false blocks beats wider coverage).
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
    return cmd, code, in_projects, transcript

def _cmd_strip(s):
    # Shared command-position prefix normalization (docker matcher and the
    # segments() seam must stay one model): compound-command keywords, brace
    # groups, negation, env-var assignments and sudo do not change which
    # command runs. Loop to a fixed point so layered prefixes (sudo FOO=1
    # docker …) expose the command too; strips only ever remove recognized
    # transparent prefixes.
    for _ in range(4):
        _prev = s
        s = re.sub(r"^[{}]\s*", "", s)                                  # brace group
        s = re.sub(r"^(?:if|while|until|elif|then|else|do)\s+", "", s)  # compound keyword
        s = re.sub(r"^!\s*", "", s)                                     # negation
        s = re.sub(r"^(?:\w+=\S*\s+)+", "", s)   # env-var prefix
        s = re.sub(r"^(?:sudo|env|command|nohup)\s+", "", s)  # transparent wrappers
        if s == _prev:
            break
    return s

def _split_punct(line):
    # Split a line into (segment, preceding-delimiter-run) pairs on shell
    # control punctuation (| ; & ( )) OUTSIDE single/double quotes. Quoted
    # punctuation is argument text, not a command boundary (rolling-r2 L165:
    # printf 'a; git merge' manufactured a fake command position). Unquoted
    # $( …) still splits — those commands really run; a quoted "$( …)" body
    # stays one segment (missed block, never false block — same fail-open
    # direction as _wt_lines' quoted-<< limit).
    out, buf, pend, q = [], [], "", None
    for ch in line:
        if q:
            buf.append(ch)
            if ch == q:
                q = None
        elif ch in "'\"":
            q = ch
            buf.append(ch)
        elif ch in "|;()&":
            if buf:
                out.append(("".join(buf), pend))
                buf, pend = [], ch
            else:
                pend += ch          # extend the run (&&, ||, (( ))
        else:
            buf.append(ch)
    if buf or pend:
        out.append(("".join(buf), pend))
    return out

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

def pairs(text):
    # Heavy seam: (segment, preceding-delimiter) pairs with the segments()
    # normalization (heredoc bodies dropped, comment lines skipped, rtk
    # stripped, prefixes stripped). The delimiter lets callers track subshell
    # depth: R3 must judge `(cd X && git checkout …)` by X, not by the hook
    # process cwd (rolling-r1 L191).
    prs = []
    for l in _wt_lines(text):
        l = re.sub(r"^rtk\s+", "", l.strip())
        if not l or l.startswith("#"):
            continue
        for seg, delim in _split_punct(l):
            prs.append((_cmd_strip(seg.strip()), delim))
    return prs

def segments(text):
    # Light seam: command positions within each line (same segment model as
    # the docker matcher).
    return [seg for seg, _d in pairs(text) if seg]

def _cwd_walk(prs, start):
    # (segment, cwd-at-that-point): cd segments move the cursor (bare cd →
    # HOME; `cd -` unknowable → keep), delimiter runs track subshell depth —
    # a cd inside ( … ) is popped when the group closes. Shared by R3 and P6
    # so both judge commands by the directory they run in (rolling-r1 L191).
    cur, stack = start, []
    for seg, delim in prs:
        for ch in delim:
            if ch == "(":
                stack.append(cur)
            elif ch == ")" and stack:
                cur = stack.pop()
        if not seg:
            continue
        mcd = re.match(r"^cd\b\s*(.*)$", seg)
        if mcd:
            try:
                toks = shlex.split(mcd.group(1).strip())
            except ValueError:
                toks = mcd.group(1).split()
            tgt = next((t for t in toks if t != "--" and not t.startswith("-")), None)
            if tgt is None:
                cur = os.path.expanduser("~")    # bare `cd` → HOME
            elif tgt != "-":                     # `cd -`: OLDPWD unknowable, keep
                tgt = os.path.expanduser(tgt)
                cur = os.path.normpath(tgt if os.path.isabs(tgt) else os.path.join(cur, tgt))
            continue
        yield seg, cur

# ═══ RULES ═══
# Matching discipline (spec #137 lesson): first-token-sequence anchored at
# command positions only — never full-text substring. The worktree-add, P2
# and P3 matchers are the remaining FULL-TEXT debt (marked inline below,
# kept verbatim by spec #142 so the debt migrates without silently changing
# shape; README "已知债" tracks them as still open).

# docker probes (which/grep/systemctl/…) are allowed; only running docker blocks.
PROBE = r"^(which|type|command\s+-v|whereis|grep|egrep|rg|ls|cat|tail|head|less|systemctl|journalctl|apt|apt-get|dpkg|nix|snap|find|stat)\b"

def _match_bare_cd(ctx):
    # Whole command is a bare cd — a no-op, bash tool uses a fresh shell.
    if ctx["code"] and all(re.fullmatch(r"cd(\s+\S+)?", l) for l in ctx["code"]):
        return {}
    return None

def _match_docker(ctx):
    # docker in command position — use sudo nerdctl (AGENTS.md). Walks the
    # non-comment lines (`code`, heredoc bodies NOT exempt — current behavior,
    # golden-locked) splitting each into command positions.
    for l in ctx["code"]:
        for seg, _d in _split_punct(l):
            s = seg.strip()
            if re.match(r"^(ssh|scp|rsync)\b", s):
                continue  # remote segment: quoted remote args (e.g. ssh host
                # 'docker ps') mis-split below, and remote hosts manage their
                # own docker — AGENTS.md rule is local-only. Later segments
                # still scan.
            s = _cmd_strip(s)
            if not s or re.match(PROBE, s):
                continue
            if re.match(r"^docker(\s|$)", s):
                return {"args": s[len("docker"):].strip()}
    return None

def _match_worktree_add(ctx):
    # debt (spec#137 review; kept verbatim by spec#142): FULL-TEXT match —
    # false-blocked heredoc document bodies twice during the spec #137
    # creation (the body quoted the command literal).
    if re.search(r"\bgit\s+worktree\s+add\b", ctx["cmd"]):
        return {}
    return None

def _match_r2(ctx):
    # Merges by raw git bypass the merge discipline (pre-merge verify gate; a
    # session that dies mid-merge leaves conflict state behind). Canonical
    # paths: personal repos merge via the worktrunk tool; remote-already-
    # merged syncs via pull --ff-only. The git pull family is fully allowed.
    for seg in segments(ctx["cmd"]):
        if re.match(r"^git\s+(?:-\S+\s+\S+\s+)*merge(\s|$)", seg) \
                and not re.search(r"(^|\s)--ff-only(\s|$)", seg) \
                and not re.search(r"(^|\s)--(?:abort|continue|quit)(\s|$)", seg):
            return {}
    return None

def _match_r3(ctx):
    # Cross-branch checkout inside a linked worktree strands the session (the
    # worktree belongs to its branch; wt switch migrates the session along).
    # The trigger is cwd-based: in a linked worktree .git is a FILE; a main
    # checkout has a .git DIRECTORY and is never touched by this rule.
    # rolling-r1 L191: the .git test follows the COMMAND's directory, not the
    # hook process cwd — `cd <linked> && git checkout main` (subshell or
    # plain) escaped when the hook ran from a main checkout; _cwd_walk tracks
    # cd + subshell depth. rolling-r2 L239: the effective worktree root also
    # has to honor `-C <dir>` and repo discovery from a SUBDIRECTORY —
    # resolve -C (chained, relative to the tracked cwd), then walk ancestors
    # for .git: FILE = linked worktree (enforce), DIRECTORY = main checkout
    # (allow), none = not a repo (allow). File restores (checkout -- <path>,
    # checkout <rev> -- <path>, checkout <existing path>) and new-branch
    # creation (-b/-B/-c/-C/--orphan) stay allowed.
    for _seg, _cur in _cwd_walk(pairs(ctx["cmd"]), ctx["cwd"]):
        _m = re.match(r"^git\s+((?:-\S+\s+\S+\s+)*)(checkout|switch)(\s|$)", _seg)
        if not _m:
            continue
        _root = _cur
        try:
            _gt = shlex.split(_m.group(1))
        except ValueError:
            _gt = _m.group(1).split()
        _j = 0
        while _j < len(_gt):
            if _gt[_j] == "-C" and _j + 1 < len(_gt):
                _d = os.path.expanduser(_gt[_j + 1])
                _root = os.path.normpath(_d if os.path.isabs(_d) else os.path.join(_root, _d))
                _j += 2
            else:
                _j += 1
        _linked = None
        _p = _root
        while True:
            _gp = os.path.join(_p, ".git")
            if os.path.isfile(_gp):
                _linked = _p
                break
            if os.path.isdir(_gp):
                break
            _parent = os.path.dirname(_p)
            if _parent == _p:
                break
            _p = _parent
        if _linked is None:
            continue
        # Layout exemption (#153, W4 ascend e932/e958/e960): R3 enforces only
        # wt-managed trees, which wt places at ~/projects/<repo>-<slug>.
        # Self-managed trees (autoresearch, pi-subagents <repo>/worktrees/<name>)
        # sit outside that template — wt switch would adopt them into wt
        # management and migrate their sessions; their own flow is the path.
        if os.path.dirname(_linked) != os.path.join(os.path.expanduser("~"), "projects") \
                or "-" not in os.path.basename(_linked):
            continue
        try:
            _args = shlex.split(_seg[_m.end():])
        except ValueError:
            _args = _seg[_m.end():].split()
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
        if _branch is None or ("--" in _args and _m.group(2) == "checkout"):
            continue
        # Full 40-hex sha: pinned-commit materialization (submodule content
        # sync), not a branch move (#153). New-branch flags (-b/-B/-c/-C/
        # --orphan) break the arg walk above, so a sha here is never creation.
        if re.fullmatch(r"[0-9a-fA-F]{40}", _branch):
            continue
        if _m.group(2) == "checkout" and os.path.exists(os.path.join(_root, _branch)):
            continue  # bare <path> restore — the path exists in this tree
        return {}
    return None

def _match_r4(ctx):
    # wt merge -y/--yes skips the approval prompt — merging is the user's
    # decision (AGENTS.md); headless workers report the pending merge to the
    # parent instead of approving it themselves.
    for seg in segments(ctx["cmd"]):
        if re.match(r"^wt\s+merge(\s|$)", seg) and re.search(r"(^|\s)(-y|--yes)(\s|$)", seg):
            return {}
    return None

BRANCH_TYPE_RE = re.compile(
    r"^(feat|fix|chore|docs|refactor|perf|test|ci|build|style|revert|research)/[A-Za-z0-9._-]+$")

def _match_r5(ctx):
    # New worktree branch naming (AGENTS.md): <type>/<name> with type from
    # the conventional-commits set plus research (wayfinder's sanctioned
    # throwaway-research type). Session mining 2026-10-26 (1007 creations,
    # 341 branches): tw/, ticket/, impl/, peer/, autoresearch/, tmp/, pick/
    # and bare names all drifted. One-off probe/tmp branches use test/ —
    # common-ci runs test* branches as test-CI branches. Command-position
    # only, token walk: `wt [opts] switch [opts] -c <branch> [opts]`.
    for seg in segments(ctx["cmd"]):
        try:
            toks = shlex.split(seg)
        except ValueError:
            toks = seg.split()
        if not toks or toks[0] != "wt" or "switch" not in toks[1:] or "-c" not in toks:
            continue
        i = toks.index("switch") + 1
        branch = None
        while i < len(toks):
            t = toks[i]
            if t == "-c":
                j = i + 1
                while j < len(toks) and toks[j].startswith("-"):
                    j += 1
                branch = toks[j] if j < len(toks) else None
                break
            if not t.startswith("-") and branch is None:
                branch = t  # positional before -c: `wt switch feat/x -c`
            i += 1
        if branch and not BRANCH_TYPE_RE.match(branch):
            return {"branch": branch}
    return None

def _match_no_verify(ctx):
    # Skipping repo hooks: commit --no-verify|-n, push --no-verify.
    # (git push -n means --dry-run, NOT --no-verify — do not blanket-match -n.)
    # rolling-r2 L291: flags belong to their own invocation — each git segment
    # is judged on its own option tokens, so `git commit -m x && git push -n`
    # (push dry-run) and `git diff | head -n 20; git commit -m x` stay legal,
    # and a flag spelled inside a -m message string is message text, not a
    # flag. Exact-token match (attached forms like -mn parse as -m n): a
    # message value that IS literally "-n"/"--no-verify" would false-block —
    # accepted, absurd input. One pass over segments so the FIRST offending
    # invocation decides commit-vs-push message (order-sensitive across
    # segments — see RULES header).
    for seg in segments(ctx["cmd"]):
        _m4 = re.match(r"^git\s+(?:-\S+\s+\S+\s+)*(commit|push)(\s|$)", seg)
        if not _m4:
            continue
        try:
            _a4 = shlex.split(seg)
        except ValueError:
            _a4 = seg.split()
        _commit4 = _m4.group(1) == "commit"
        for _t in _a4:
            if _t == "--no-verify" or (_t == "-n" and _commit4):
                return {"sub": _m4.group(1)}
    return None

def _match_p7(ctx):
    # P7. `pkill -f <pattern>` whose pattern would match the pkill command
    # itself (e.g. `pkill -f my_worker.py` — the pkill process's own cmdline
    # contains the pattern; pkill excludes itself but any sibling shell/wrapper
    # carrying the same literal in its cmdline dies, including the calling
    # bash -c). 21 hits across 3 sessions before the [x] convention stuck.
    # Block only when the pattern is a bare literal without a bracket-escape.
    for seg in segments(ctx["cmd"]):
        m = re.match(r"^pkill\s+-f\s+(\S+)", seg)
        if not m:
            continue
        pat = m.group(1).strip("'\"")
        if "[" in pat:  # already bracket-escaped: pkill -f '[m]y_worker'
            continue
        if pat and re.search(re.escape(pat), f"pkill -f {pat}"):
            return {"pattern": pat}
    return None

def _match_p8(ctx):
    # P8. Hand-written NESTED-quote ssh (17 hits / 41 days, two violations
    # AFTER the rule was written). Single-quoted simple remote commands
    # (`ssh host 'docker ps'`) are legitimate shell transport — the hell is
    # quoting INSIDE the quoted payload (double-wrapping, escaped quotes,
    # $(...) with its own quotes): the scp-first pattern (rsh.sh / local
    # script + scp) is the sanctioned channel for those. Trigger: the remote
    # command's quoted body itself contains quote characters.
    for seg in segments(ctx["cmd"]):
        m = re.match(r"^ssh\s+(?:-\S+\s+)*(\S+@\S+|\S+)\s+(.+)$", seg)
        if not m:
            continue
        remote = m.group(2)
        # strip the outer transport quotes (one layer), then look for more
        body = remote.strip()
        if len(body) >= 2 and body[0] == body[-1] and body[0] in "\"'":
            body = body[1:-1]
        if any(q in body for q in ("\"", "'")):
            return {"host": m.group(1)}
    return None

def _match_p9(ctx):
    # P9. `wt remove` on the worktree the session is currently sitting in:
    # the session's bash/codemode all spawn ENOENT afterwards (2026-10-15,
    # 10-21, 10-22, 10-27 — four incidents). wt refuses the worktree you are
    # SITTING in, but only when it can see the cwd; the trap is `wt -C <path>
    # remove` from elsewhere, or removing a path the session cd-ed into via a
    # previous segment. Resolve each remove target against the tracked cwd.
    for _seg, _cur in _cwd_walk(pairs(ctx["cmd"]), ctx["cwd"]):
        m = re.match(r"^wt\s+(?:-C\s+(\S+)\s+)?remove\s+(.+)$", _seg)
        if not m:
            continue
        targets = m.group(2).split()
        base = os.path.expanduser(m.group(1)) if m.group(1) else _cur
        for t in targets:
            cand = os.path.normpath(os.path.expanduser(t))
            if not os.path.isabs(cand):
                # branch-name form: wt maps it to ~/projects/<repo>-<branch>;
                # the session is exposed if its cwd's basename (or any
                # ancestor under ~/projects) ends with -<branch> — that is
                # the sibling path wt would remove.
                import glob as _g
                hits = _g.glob(os.path.expanduser(f"~/projects/*-{t}"))
                exposed = any(_cur == h or _cur.startswith(h + os.sep) for h in hits)
                tail = _cur.rsplit(os.sep, 1)[-1]
                if not exposed and tail.endswith("-" + t):
                    exposed = True
                if exposed:
                    return {"target": t, "cwd": _cur}
                continue
            if os.path.normpath(_cur) == cand or _cur.startswith(cand + os.sep):
                return {"target": t, "cwd": _cur}
    return None

def _match_g1(ctx):
    # Hand-copying into the pi agent dirs (global: the agent install lives
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
    for _seg in segments(ctx["cmd"]):
        # rolling-r2 L340: judge each cp/ln command segment's own argument list —
        # the whole line is not one argv (`cp x ~/.pi/… && echo done` made `done`
        # the destination; `mkdir -p … && cp x ~/.pi/…` was skipped wholesale).
        # Segments come pre-stripped by _cmd_strip, so env/sudo-wrapped copies
        # land here too; heredoc bodies are already gone.
        if not re.match(r"^(ln|cp)\s", _seg):
            continue
        try:
            argv = shlex.split(_seg)[1:]
        except ValueError:
            argv = _seg.split()[1:]
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
        # rolling-r1 L278: the shell expands ~/$HOME before the copy runs — expand
        # the common forms here and re-check, so the destination can't hide behind
        # them. Vars the hook env can't resolve ($PI_EXTENSIONS-style indirection)
        # can't be judged: reject rather than wave an unknown destination at the
        # managed dirs (unjudgeable destination → fail-closed, #153).
        _dest = os.path.expanduser(os.path.expandvars(dest))
        if "$" in _dest:
            return {"kind": "var", "dest": dest}
        if re.search(r"(\.pi/agent/(extensions|skills)|\.agents/skills)(/|\s|['\"]|$)", _dest):
            return {"kind": "dest"}
    return None

def _match_p2(ctx):
    # P2. git add -A / --all / . — stage files explicitly (AGENTS.md repo
    # rule; 15 repos, ~960 calls mined).
    # Command-position match (2026-10-26, R1 grilling upgrade from FULL-TEXT):
    # only a segment that STARTS with git add is an execution — literals inside
    # echo strings / comments / heredoc bodies are not. Evidence: 16
    # interceptions in one session, 15 pure literals (94% false-block), and the
    # FULL-TEXT made analyzing the guard itself impossible (any diagnostic
    # script quoting the blocked literal was blocked too). Fail direction is
    # now missed blocks (var indirection X="git add -A"; $X), consistent with
    # the fail-open philosophy.
    for seg in segments(ctx["cmd"]):
        if re.match(r"^git\s+add\b", seg) and re.search(
            r"^git\s+add\s+(?:-\S*\s+)*(?:-A\b|--all\b|\.(?:\s|$))", seg
        ):
            return {}
    return None

def _match_p3(ctx):
    # P3. Foreground sleep >= 60s parks the whole turn (14 repos, ~700 calls,
    # tens of hours of wall clock; near-zero bg adoption). Nudge, don't
    # block: exit 2 with a redirect is the nudge channel pi-hooks gives us.
    # Command-position match (2026-10-26, R1 grilling upgrade from FULL-TEXT,
    # same rationale/evidence as P2): only segments headed by sleep are
    # executions; literals in strings/comments/heredoc bodies are not.
    for seg in segments(ctx["cmd"]):
        m = re.match(r"^sleep\s+(\d+)([smh]?)\b", seg)
        if not m:
            continue
        n, unit = int(m.group(1)), m.group(2)
        seconds = n * {"": 1, "s": 1, "m": 60, "h": 3600}[unit]
        if seconds >= 60:
            return {"spec": m.group(1) + unit, "seconds": seconds}
    return None

def _match_sleep_chain(ctx):
    # sleep-chain. `sleep N && …` polling: short chained sleeps escape P3's
    # 60s threshold but the turn still parks serially on a hand-rolled wait
    # loop. Command-position match on the segments seam (not full-text, same
    # rationale as P2/P3); a trailing sleep with nothing chained after it is
    # a plain backoff and stays allowed. Scope global: polling waste is not
    # repo-specific (user request 2026-10-27).
    prs = pairs(ctx["cmd"])
    for i, (seg, _d) in enumerate(prs):
        if re.match(r"^sleep\s+\S+", seg) and i + 1 < len(prs):
            return {"spec": seg.split(None, 1)[1][:40]}
    return None

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
#
# rolling-r2 L410: every probe runs against the repo the commit TARGETS —
# -C/--git-dir global options of the segment, cwd tracked through cd
# segments (_cwd_walk) — not the hook process cwd. The old process-cwd
# probes let `git -C /other commit` and `cd /other && git commit` read
# the session repo's identity/remotes. The full-text `--no-verify` gate
# exclusion is gone: guard 4 already blocks those commits before this
# point, and the old exclusion let a later `git push -n` silence the
# check for an earlier clean commit. No fallback outside command
# positions (the old full-text-matched fallback re-probed the hook cwd
# and false-blocked string literals like echo 'git commit').
# Identity map is node-local, not source code: loaded from
# ~/.pi/agent/bash-guards-identity.conf (KEY=VALUE, keys are remote-URL
# substrings; DEFAULT_EMAIL for repos with no remote). The shipped example
# holds placeholder values — the real values live only on the node.
P6_EXPECTED = {"gitblue.example": "dev@corp.example", "github": "dev@personal.example"}
P6_DEFAULT_EMAIL = "dev@corp.example"
_IDENTITY_CONF = os.environ.get("BASH_GUARDS_IDENTITY_CONF", os.path.expanduser("~/.pi/agent/bash-guards-identity.conf"))
if os.path.isfile(_IDENTITY_CONF):
    try:
        for line in open(_IDENTITY_CONF):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k == "DEFAULT_EMAIL":
                P6_DEFAULT_EMAIL = v.strip()
            else:
                P6_EXPECTED[k.strip()] = v.strip()
    except OSError:
        pass  # unreadable conf: ship defaults, fail open

def _p6_probe(seg, cur):
    # Identity verdict for one commit segment, probed in the repo it targets.
    # Returns message params on identity mismatch, None when the target is not
    # a resolvable repo or its remote platform is unknown — fail open, never
    # block on our own probe failure (rolling-r1 L350/L352).
    _mg = re.match(r"^git\s+((?:-\S+\s+\S+\s+)*)commit(\s|$)", seg)
    if not _mg:
        return None
    try:
        _gt = shlex.split(_mg.group(1))
    except ValueError:
        _gt = _mg.group(1).split()
    _pre, _i, _dir = [], 0, cur
    while _i < len(_gt):
        _a = _gt[_i]
        if _a == "-C" and _i + 1 < len(_gt):
            _d = os.path.expanduser(_gt[_i + 1])
            _dir = os.path.normpath(_d if os.path.isabs(_d) else os.path.join(_dir, _d))
            _pre += ["-C", _dir]
            _i += 2
        elif _a.startswith("--git-dir="):
            _d = os.path.expanduser(_a.split("=", 1)[1])
            _d = os.path.normpath(_d if os.path.isabs(_d) else os.path.join(_dir, _d))
            _pre += ["--git-dir=" + _d]
            _i += 1
        else:
            _pre.append(_a)   # -c key=val and friends pass through
            _i += 1
    try:
        _pe = subprocess.run(["git"] + _pre + ["config", "user.email"],
                             capture_output=True, text=True, timeout=5, cwd=_dir)
        _pr = subprocess.run(["git"] + _pre + ["remote", "-v"],
                             capture_output=True, text=True, timeout=5, cwd=_dir)
    except (OSError, subprocess.SubprocessError):
        return None
    if _pe.returncode not in (0, 1) or _pr.returncode != 0:
        return None  # rc 1 = email unset (legal); other rc = not a resolvable repo
    email = _pe.stdout.strip()
    remotes = _pr.stdout
    remote_urls = sorted({m.group(1).lower() for m in re.finditer(r"^\S+\s+(\S+)\s+\(fetch\)$", remotes, re.M)})
    want_any = {v for url in remote_urls for k, v in P6_EXPECTED.items() if k in url}
    if remote_urls:
        if not want_any:
            return None  # rolling-r1 L350: unknown remote platform — fail open
        # push-remote resolution chain, for naming the platform in the
        # message. rolling-r1 L352: same fail-open as the other probes —
        # a timeout/missing git here must not raise out of the hook.
        try:
            branch = subprocess.run(["git"] + _pre + ["branch", "--show-current"],
                                    capture_output=True, text=True, timeout=5, check=False, cwd=_dir).stdout.strip()
            push_remote = subprocess.run(["git"] + _pre + ["config", f"branch.{branch}.pushRemote"],
                                         capture_output=True, text=True, timeout=5, check=False, cwd=_dir).stdout.strip() \
                or subprocess.run(["git"] + _pre + ["config", "remote.pushDefault"],
                                  capture_output=True, text=True, timeout=5, check=False, cwd=_dir).stdout.strip() or "origin"
        except (OSError, subprocess.SubprocessError):
            return None
        push_url = next((u for u in remote_urls if push_remote and push_remote in
                         {r.group(1) for r in re.finditer(rf"^{re.escape(push_remote)}\s+(\S+)\s+\(fetch\)$", remotes, re.M)}),
                        remote_urls[0])
        platform = next((k for k in P6_EXPECTED if k in push_url), push_remote or "the default")
    else:
        platform = "the default"
        want_any = {P6_DEFAULT_EMAIL}  # no remote: default identity is the only match
    suggest = next(iter(sorted(want_any)), P6_DEFAULT_EMAIL)
    # rolling-r1 L334: scan only real `git -c user.email=…` arguments —
    # a literal inside a -m message body is not an identity override.
    # With an inline override the commit runs under it; without one it
    # runs under the configured email of the target repo.
    try:
        _argv = shlex.split(seg)
    except ValueError:
        _argv = seg.split()
    _inline = None
    _i = 0
    while _i < len(_argv):
        _a = _argv[_i]
        if _a == "-c" and _i + 1 < len(_argv):
            _kv = _argv[_i + 1]
            _i += 2
        elif _a.startswith("-c") and len(_a) > 2:
            _kv = _a[2:]
            _i += 1
        else:
            _i += 1
            continue
        if _kv.startswith("user.email="):
            _inline = _kv[len("user.email="):]  # last -c wins (git semantics)
    if _inline is not None:
        if _inline not in want_any:
            return {"kind": "inline", "inline": _inline, "platform": platform,
                    "expected": ", ".join(sorted(want_any))}
    elif email not in want_any:
        return {"kind": "email", "email": email or "(no email configured)",
                "platform": platform, "expected": ", ".join(sorted(want_any)),
                "suggest": suggest}
    return None

def _match_p6(ctx):
    if re.search(r"\bgit\s+(?:-\S+\s+\S+\s+)*commit(\s|$)", ctx["cmd"]):
        for seg, cur in _cwd_walk(pairs(ctx["cmd"]), ctx["cwd"]):
            if re.match(r"^git\s+(?:-\S+\s+\S+\s+)*commit(\s|$)", seg):
                params = _p6_probe(seg, cur)
                if params is not None:
                    return params
    return None

# Order IS behavior: entries run in this sequence, first hit wins.
# ═══ KB GATE ═══
# KB. Knowledge-base-first gate (2026-10-26): cluster/service probing in a
# session that never touched the diagnosis vault is blocked once, with the
# vault search as the route back. Evidence: doc-consumption audit
# 2026-10-16 (1164 sessions/8 repos) — wiki touches were 61% external-force
# driven, spontaneous wiki reads 2 cases; diagnostic work re-derived known
# root causes already in ~/ops. Narrow triggers only (cluster runtime
# probing — kubectl/crictl/journalctl/dmesg/nvidia-smi; helm/nerdctl are
# deploy/mgmt-heavy and stay ungated). The gate opens for the whole session
# once ANY command touches ~/ops or llmops-wiki (reading the index, running
# the diag-search rg, writing a diagnosis — all qualify). Weak read signal:
# every gate decision appends a monthly jsonl read log under
# ~/.pi/agent/kendex/state/kb/ — future doc-consumption audits read it
# instead of mining session JSONL.
KB_TRIGGER = re.compile(r"^(kubectl|crictl|journalctl|dmesg|nvidia-smi)\b")
KB_TOUCH = re.compile(r"(~/ops|\$HOME/ops|/mnt/disk1/hyx/ops)\b|llmops-wiki")
# Doc granularity for the satisfy read log: pull the concrete doc path out of
# the command — ops filename, wiki topic dir (first two path segments). Path
# chars stop at shell separators; globs like *.md are kept as-is (weak signal
# is fine — the log is for doc-consumption audits, not gating).
_KB_OPS_DOC = re.compile(r"(?:~/ops|\$HOME/ops|/mnt/disk1/hyx/ops)/([^\s;|&<>)\"'`]+)")
_KB_WIKI_DOC = re.compile(r"llmops-wiki/([^\s;|&<>)\"'`]+)")


def _kb_docs(cmd):
    docs = []
    for m in _KB_OPS_DOC.finditer(cmd):
        name = os.path.basename(m.group(1).rstrip("/"))
        if name and name not in docs:
            docs.append(name)
    for m in _KB_WIKI_DOC.finditer(cmd):
        parts = [p for p in m.group(1).split("/") if p]
        if parts:
            doc = "/".join(parts[:2])
            if doc not in docs:
                docs.append(doc)
    return docs[0] if len(docs) == 1 else (docs or None)

def _kb_session_key(transcript):
    # Per-session identity from the transcript path; no transcript -> None
    # (fail open — cannot track, never block).
    return hashlib.sha1(transcript.encode()).hexdigest()[:16] if transcript else None

def _kb_log(session, kind, cmd, doc=None):
    # Monthly read log; a logging failure must never block (fail open).
    try:
        d = os.path.expanduser("~/.pi/agent/kendex/state/kb")
        os.makedirs(d, exist_ok=True)
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
               "session": session, "kind": kind, "cmd": cmd[:200]}
        if kind == "satisfy":
            rec["doc"] = doc
        with open(os.path.join(d, time.strftime("readlog-%Y%m.jsonl")), "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass

def _match_kb(ctx):
    session = _kb_session_key(ctx.get("transcript", ""))
    if session is None:
        return None
    flag = os.path.expanduser(f"~/.pi/agent/kendex/state/kb/flag-{session}")
    if KB_TOUCH.search(ctx["cmd"]):
        # Touching the KB is itself the satisfying action: open the gate.
        try:
            os.makedirs(os.path.dirname(flag), exist_ok=True)
            open(flag, "w").close()
        except OSError:
            pass
        _kb_log(session, "satisfy", ctx["cmd"], _kb_docs(ctx["cmd"]))
        return None
    for seg in segments(ctx["cmd"]):
        s = _cmd_strip(seg.strip())
        if not KB_TRIGGER.match(s):
            continue
        if os.path.exists(flag):
            _kb_log(session, "pass", s)
        else:
            _kb_log(session, "block", s)
            return {"cmd": s}
        break
    return None


RULES = [
    # 1. whole command is a bare cd (mining: 49 calls/38 sessions)
    {"id": "bare-cd", "scope": "global", "matcher": _match_bare_cd, "message": "bare-cd"},
    # 2. docker in command position (mining: 353 calls/77 sessions)
    {"id": "docker", "scope": "global", "matcher": _match_docker, "message": "docker"},
    # 3. raw worktree creation — wt owns the lifecycle (debt: full-text;
    #    mining: 139 calls/63 sessions)
    {"id": "worktree-add", "scope": "global", "matcher": _match_worktree_add, "message": "worktree-add"},
    # R1. raw worktree remove/prune (MR !688; fix-eda-scan-fixes cwd deletion)
    {"id": "R1", "scope": "global",
     "matcher": r"git\s+(?:-\S+\s+\S+\s+)*worktree\s+(?:remove|prune)(\s|$)", "message": "R1"},
    # R2. raw git merge (non --ff-only, not abort/continue/quit)
    {"id": "R2", "scope": "global", "matcher": _match_r2, "message": "R2"},
    # R3. cross-branch checkout/switch in a linked worktree (.git is a file)
    {"id": "R3", "scope": "global", "matcher": _match_r3, "message": "R3"},
    # R4. wt merge approval flag
    {"id": "R4", "scope": "global", "matcher": _match_r4, "message": "R4"},
    # R5. new worktree branch naming: <type>/<name>, conventional types +
    #    research (mining 2026-10-26: 24 off-contract creations / 20 sessions)
    {"id": "R5", "scope": "global", "matcher": _match_r5, "message": "R5"},
    # 4. commit/push --no-verify|-n (mining: 17 calls/7 sessions; two messages)
    {"id": "no-verify", "scope": "global", "matcher": _match_no_verify, "message": "no-verify"},
    # G1. hand-copy into the pi agent dirs (two messages)
    {"id": "G1", "scope": "global", "matcher": _match_g1, "message": "G1"},
    # P2/P3/P6: projects layer only (session cwd under ~/projects)
    {"id": "P2", "scope": "projects", "matcher": _match_p2, "message": "P2"},
    {"id": "P3", "scope": "projects", "matcher": _match_p3, "message": "P3"},
    # sleep-chain. `sleep N && …` polling (the short-sleep escape from P3)
    {"id": "sleep-chain", "scope": "global", "matcher": _match_sleep_chain, "message": "sleep-chain"},
    # P6. commit identity (two messages)
    {"id": "P6", "scope": "projects", "matcher": _match_p6, "message": "P6"},
    # KB. knowledge-base-first gate: cluster probing requires the vault read
    {"id": "KB", "scope": "projects", "matcher": _match_kb, "message": "KB"},
    # P7. pkill -f self-match suicide (21 hits / 3 sessions)
    {"id": "P7", "scope": "global", "matcher": _match_p7, "message": "P7"},
    # P8. hand-written nested-quote ssh (17 hits / 41 days)
    {"id": "P8", "scope": "global", "matcher": _match_p8, "message": "P8"},
    # P9. wt remove on the session's own worktree (4 incidents)
    {"id": "P9", "scope": "global", "matcher": _match_p9, "message": "P9"},
]

# ═══ MESSAGES ═══
# Every verdict text: reason + correct replacement command + example
# (three elements, asserted by tests/messages.test.ts; the exit IS the
# replacement command — no bypass channel, #153). Static entries are format
# templates ({placeholder}); dynamic ones are callables over the matcher's
# params. Texts are verbatim from the pre-migration engine (golden-locked).

MESSAGES = {
    # SA1-SA4: pi-subagents parameter-shape guards (2026-10-22 four-axis mining).
    "SA1": "subagent: options must be an object, not a JSON string — got: {preview}. "
           "All string-options calls errored (mining 4/4); the object form is the contract. "
           "Re-run with the parsed object, e.g. options: {{\"index\": 0}}.",
    "SA2": "subagent: workflowScriptPath was removed from the contract — got: {val}. "
           "Re-run with the path as workflow: \"<path>\" (relative ./x resolves against "
           "cwd; ~ does not expand — use the absolute path).",
    "SA3": "subagent: workflow path \"{val}\" starts with ~, which the harness does not "
           "expand — it becomes <cwd>/~/... and fails with ENOENT. "
           "Re-run with the absolute path (/mnt/disk1/hyx/...).",
    "SA4": "subagent: unknown agent \"{agent}\" — general/general-purpose do not exist "
           "and oracle is disabled. Re-run subagent({{action: \"list\"}}) first and pick "
           "from the roster; guessing the name burns a round-trip every time.",
    "bare-cd": "bare `cd <dir>` is a no-op: the bash tool runs each command in a "
               "fresh shell, so the working directory does not persist. "
               "Re-run as: (cd <dir> && <command>) — e.g. "
               "(cd /mnt/disk1/hyx/projects/HAMi && git status) — or use absolute paths.",
    "docker": "docker is forbidden on this node (AGENTS.md). "
              "Re-run with nerdctl, same subcommand: `sudo nerdctl {args}` — e.g. docker pull X → "
              "sudo nerdctl pull X. Images/containers are managed via "
              "sudo nerdctl; base images auto-pull to the buildkit namespace.",
    "worktree-add": "raw `git worktree add` is forbidden (AGENTS.md): worktrees are "
                    "managed by wt, which computes sibling paths (~/projects/<repo>-"
                    "<branch-slug>) and runs dependency hooks. Re-run as: "
                    "`wt switch -c <branch>` — e.g. wt switch -c feat/x. Removal: "
                    "wt remove <branch>, never delete the directory by hand.",
    "R1": "raw `git worktree remove/prune` destroys worktrees without the "
          "safety checks wt has — twice this has deleted the directory a "
          "running session sat in (MR !688 HAMi cleanup; 2026-10-21 "
          "fix-eda-scan-fixes: bash deleted its own cwd → spawn ENOENT, "
          "session dead 2h). Re-run with wt: `wt remove <branch>` — e.g. "
          "`wt remove feat/x` (it refuses the worktree you are sitting "
          "in). If this is documentation quoting the command, rephrase "
          "the wording or base64 it — the guard reads command position "
          "only.",
    "R2": "raw `git merge` bypasses the merge discipline (pre-merge verify "
          "gate; sessions have died mid-merge leaving conflict state "
          "behind). Personal repos: merge with the worktrunk tool — "
          "`wt merge` (verify + merge + session migration). If the remote "
          "already contains the branch, sync instead: `git pull --ff-only` "
          "— e.g. `git pull --ff-only origin main`.",
    "R3": "`git checkout <branch>`/`git switch <branch>` inside a linked "
          "worktree moves this tree off its branch and strands the "
          "session (processes anchored to the old branch break — same "
          "class as the !688 / 2026-10-21 cwd-deletion incidents). "
          "Re-run with wt: `wt switch <branch>` — e.g. `wt switch main` "
          "— which migrates the session with the checkout. File restores "
          "(`git checkout -- <path>`) and new branch creation "
          "(`git checkout -b <name>`) stay allowed.",
    "R4": "`wt merge -y/--yes` auto-approves the merge — merge approval is "
          "the user's decision (AGENTS.md), not the agent's. Re-run "
          "without -y/--yes and answer the prompt (`wt merge`), or stop "
          "and report the pending merge to the parent/user session for "
          "approval (headless convention: `wt merge --no-remove` + "
          "report, never -y).",
    "R5": "new worktree branches follow `<type>/<name>` (AGENTS.md): type from "
          "the conventional-commits set (feat/fix/chore/docs/refactor/perf/"
          "test/ci/build/style/revert) plus research (wayfinder throwaway "
          "research branches). `{branch}` is off-contract — mining found "
          "tw/, ticket/, impl/, peer/, tmp/ and bare names drifting. Re-run "
          "with a conventional type: `wt switch -c feat/<name>` — one-off "
          "probe/tmp branches use `test/<name>` (common-ci treats test* "
          "branches as test-CI branches).",
    "no-verify-commit": "git commit --no-verify skips repo hooks (AGENTS.md never-do). "
                        "Drop the --no-verify/-n flag. If a hook fails, run it manually "
                        "to see the error (e.g. bash .git/hooks/pre-commit) and fix the "
                        "reported issue instead of bypassing validation.",
    "no-verify-push": "git push --no-verify skips pre-push guards (e.g. the gitleaks "
                      "secret scan in ~/skills). Drop --no-verify. To see what the hook "
                      "would flag before pushing, run: gitleaks git --log-opts "
                      "'origin/main..HEAD' -c ~/data/benchmark/config/gitleaks.toml . "
                      "— fix any finding, then push normally.",
    "G1-var": "copy destination {dest} holds a variable this guard cannot "
              "resolve — rerun with a literal path so the agent-dir hand-copy "
              "guard can judge it.",
    "G1-dest": "placing files into ~/.pi/agent/extensions or ~/.agents/skills by "
               "hand is forbidden (AGENTS.md) — installs drift and shadow the "
               "managed copies. Channels: skills -> edit the ~/skills source repo "
               "and commit (post-commit reinstall runs for you); extensions/pi "
               "packages -> edit ~/skills/extensions + package.json manifest, "
               "then `pi install /mnt/disk1/hyx/skills`; third-party packages -> "
               "`pi install npm:<name>`. If you only meant to READ from the "
               "install dir, copy from it into ~/tmp instead — that stays allowed "
               "(only the destination is guarded).",
    "P2": "`git add -A/-a-all/.` stages everything including other "
          "sessions' in-progress work — AGENTS.md requires staging only "
          "this task's files. Re-run with explicit paths: `git add "
          "<file1> <file2>` (find them with `git status --short`), or "
          "`git add -u` to stage modifications of already-tracked files "
          "only.",
    "P3": "foreground `sleep {spec}` parks this whole turn "
          "for {seconds}s while nothing else can happen. Long waits "
          "should be event-driven: use the pi-events-daemon tools "
          "(`subscribe` with a check/entity — it wakes this session "
          "on completion), or `bg_run` for one-shot background "
          "commands. Genuine short backoff: keep it under 60s and "
          "standalone — chained `sleep N && …` is blocked by the "
          "sleep-chain guard.",
    "sleep-chain": "`sleep {spec} && …` is a hand-rolled poll — the turn "
               "parks serially until the chained step runs. Mount an "
               "event subscription instead: read /skill:pi-events-daemon "
               "and use `subscribe` (a check/entity subscription wakes "
               "this session on the state change you are waiting for). "
               "If a subscription cannot cover the case, fall back to the "
               "bg_* tools: start the work with `bg_run` and let its "
               "completion notification wake you.",
    "P6-inline": "git -c user.email={inline} matches no remote platform "
                 "of this repo ({platform} is the push target; expected "
                 "{expected}). Commit with the matching identity.",
    "P6-email": "committing as {email} — matches no "
                "remote platform of this repo ({platform} is the push target; "
                "expected {expected}) — "
                "mixed identities forced a history rewrite once already "
                "(pi-arena, 35 commits in two identities). Fix first: "
                "`git config user.email {suggest}` (repo-local), or "
                "commit with `git -c user.email={suggest} commit …`.",
    # selectors: two-message rules pick the template from the match params
    "no-verify": lambda p: MESSAGES["no-verify-commit"] if p["sub"] == "commit" else MESSAGES["no-verify-push"],
    "G1": lambda p: MESSAGES["G1-var"].format(dest=p["dest"]) if p["kind"] == "var" else MESSAGES["G1-dest"],
    "P6": lambda p: MESSAGES["P6-inline"].format(**p) if p["kind"] == "inline" else MESSAGES["P6-email"].format(**p),
    "P7": "`pkill -f {pattern}` matches the pkill command's own cmdline — "
          "any wrapper shell carrying the same literal dies with it "
          "(21 hits across 3 sessions). Bracket-escape one char — "
          "e.g. pattern `my_worker.py` becomes `'[m]y_worker.py'` — so "
          "the literal no longer self-matches, or kill by pid.",
    "P8": "hand-written nested-quote ssh is the quoting-hell family "
          "(17 hits / 41 days, two violations even after the rule). "
          "Write the payload as a local script, scp it over, execute — "
          "in this repo that is `data/scripts/pipeline/rsh.sh <host> "
          "<cmd>` (scp-first). Re-run via rsh.sh or write the script "
          "file first.",
    "P9": "`wt remove {target}` would delete the worktree this session "
          "is sitting in (cwd={cwd}) — the session's bash/codemode all "
          "die with ENOENT (4 incidents: 10-15/10-21/10-22/10-27). "
          "`wt switch main` (or any surviving checkout) FIRST, verify "
          "with `pwd`, then remove.",
    "KB": "KB gate: cluster/service probing in a session that has not read the "
          "diagnosis vault (doc-consumption audit 2026-10-16: diagnostic "
          "sessions routinely re-derived root causes already in ~/ops). Run "
          "the vault search first — `rg -l 'labels:.*<component>' ~/ops/*.md`, "
          "then a symptom-keyword pass `rg -il -e '<kw1>' -e '<kw2>' ~/ops/*.md` "
          "(/skill:diag-search Step 2), or read `~/ops/index.md`. Any command "
          "touching ~/ops or ~/projects/llmops-wiki opens this gate for the "
          "rest of the session.",
}

# ═══ VERDICT ═══

def render_message(spec, params):
    # A message template renders against the matcher's params; callables take
    # the params dict (selectors pick one of the rule's two templates),
    # format-templates substitute ({placeholder}).
    return spec(params) if callable(spec) else spec.format(**params)

def block(msg):
    print(msg, file=sys.stderr)
    sys.exit(2)

def _match(matcher, ctx):
    # matcher polymorphism (ADR-0001): regex strings are anchored re.match at
    # every segments() command position; callables take the full ctx and run
    # their own seam iteration, returning message params or None.
    if callable(matcher):
        return matcher(ctx)
    for seg in segments(ctx["cmd"]):
        if re.match(matcher, seg):
            return {}
    return None

# ═══ SUBAGENT RULES (SA) ═══
# pi-subagents tool calls carry an args dict without a `command` key. The
# hook registry (kendex/hooks.json) routes matcher "subagent" to this same
# engine; four parameter-shape failures mined 2026-10-22 (~/tmp/subagent-diag/
# four-axis reports, 228 unique calls / 23 errors) are deterministic from the
# args alone and each costs a wasted round-trip when not told inline.

SUBAGENT_AGENT_BLACKLIST = {"general", "general-purpose", "oracle"}


def _subagent_shaped(args):
    # Extension-tool gate: only judge payloads that carry subagent-ish keys.
    # Other no-command tools (edit/write/codemode/ask_user) fail open here.
    return isinstance(args, dict) and any(
        k in args for k in ("agent", "task", "workflow", "action", "options", "workflowScriptPath")
    )


def _sa_options_string(args):
    v = args.get("options")
    if isinstance(v, str):
        return {"preview": v[:120]}
    return None


def _sa_legacy_script_path(args):
    if "workflowScriptPath" in args:
        return {"val": str(args["workflowScriptPath"])[:120]}
    return None


def _sa_tilde_path(args):
    v = args.get("workflow")
    if isinstance(v, str) and v.startswith("~"):
        return {"val": v[:120]}
    return None


def _sa_blacklisted_agent(args):
    a = args.get("agent")
    if isinstance(a, str) and a.lower() in SUBAGENT_AGENT_BLACKLIST:
        return {"agent": a}
    return None


SUBAGENT_RULES = [
    # SA1. options passed as a JSON string (mining: 4/4 string calls failed,
    #      14/14 object calls ok; 3rd retry finally fixed it twice)
    {"id": "SA1", "scope": "global", "matcher": _sa_options_string, "message": "SA1"},
    # SA2. removed parameter still in circulation (teaching error in place)
    {"id": "SA2", "scope": "global", "matcher": _sa_legacy_script_path, "message": "SA2"},
    # SA3. ~ workflow path: harness prepends cwd -> <cwd>/~/... ENOENT
    {"id": "SA3", "scope": "global", "matcher": _sa_tilde_path, "message": "SA3"},
    # SA4. agent names not in the registry (mining: general x2, oracle disabled)
    {"id": "SA4", "scope": "global", "matcher": _sa_blacklisted_agent, "message": "SA4"},
]


def subagent_main(args):
    for rule in SUBAGENT_RULES:
        params = rule["matcher"](args)
        if params is None:
            continue
        block(render_message(MESSAGES[rule["message"]], params))
    return 0


def _rescue_cwd():
    # Ticket #175: when the session cwd is a recycled worktree, spawn inherits
    # a dead directory and the hook process dies before any verdict (two
    # confirmed full-lockout incidents 2026-10-26 — every bash call returned
    # hook-exit=-1 with no way for the agent to self-rescue). The guard must
    # never be the thing that hard-locks the session: park on /tmp and judge.
    try:
        os.getcwd()
    except OSError:
        try:
            os.chdir("/tmp")
        except OSError:
            pass  # even /tmp unwritable: proceed, individual rules fail open


def main():
    _rescue_cwd()
    raw = sys.stdin.read()
    try:
        tool_input = json.loads(raw).get("tool_input") or {}
    except Exception:
        return 0  # unreadable payload: never block on our own parsing bug
    if not isinstance(tool_input, dict):
        return 0
    # Extension-tool branch first: subagent calls carry args without a
    # command key, and parse_payload maps their absence to "", not None.
    if "command" not in tool_input and _subagent_shaped(tool_input):
        return subagent_main(tool_input)
    parsed = parse_payload(io.StringIO(raw))
    if parsed is None:
        return 0
    cmd, code, in_projects, transcript = parsed
    ctx = {"cmd": cmd, "code": code, "in_projects": in_projects, "cwd": os.getcwd(),
           "transcript": transcript}
    for rule in RULES:
        if rule["scope"] == "projects" and not ctx["in_projects"]:
            continue
        params = _match(rule["matcher"], ctx)
        if params is None:
            continue
        block(render_message(MESSAGES[rule["message"]], params))
    return 0

if __name__ == "__main__":
    sys.exit(main())
