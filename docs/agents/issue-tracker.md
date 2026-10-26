# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
## Issue tracker CLI (`tracker`)

The repo ships a dedicated CLI, `tracker/` (Go), that abstracts ticket storage
behind backends. It supersedes the raw `gh` recipes above for wayfinder-style
work; those recipes remain valid fallbacks.

```bash
go build -o ~/tmp/tracker ./tracker   # from repo root; no install step yet
```

### Backends

```bash
tracker --backend local  ...                          # default: .scratch/ markdown (original behavior, unchanged)
tracker --backend github  --repo owner/name ...       # GitHub issues via gh CLI
tracker --backend gitlab  --repo group/project --gitlab-host <host> ...   # self-hosted GitLab via glab api
```

Mapping (why tickets don't look 1:1 with issues): `map/type/triage` → labels;
`claimed` → open + `status/claimed` label; `blocked_by` → `Blocked by: #n`
marker line in the issue body; comments → platform comments. Canonical
mapping rationale: `tracker/tracker/backend.go` header comment.

### Operations

```bash
tracker ticket create --map <slug> --title "..." --type task [--triage ready-for-agent] [--blocked-by 1,2]
tracker ticket list   --map <slug> [--status open] [--type task] [--triage-null]
tracker ticket view   --map <slug> --id <n>          # body + comments as JSON
tracker ticket comment --map <slug> --id <n> --body "..."
tracker ticket status --map <slug> --id <n> --set claimed|resolved|open
tracker ticket triage --map <slug> --id <n> --set ready-for-agent
tracker ticket blocking --map <slug> --id <n> --by 1,2
tracker query frontier --map <slug>                  # open + unblocked + untriaged/ready-for-agent
```

### close-verify (merge closure gap)

Closing patterns (Closes/Fixes/Resolves #n) only auto-close issues when the
merge lands on the default branch — non-default-branch merges, merge commits
with multiple refs, and squash merges silently drop some. `close-verify`
re-scans the PR/MR description **and every commit message**, checks each
referenced ticket's state, and with `--apply` closes the missed ones
(comment records the merge source):

```bash
tracker --backend github --repo owner/name ticket close-verify --ref <PR-number|merge-SHA>          # dry-run (default)
tracker --backend github --repo owner/name ticket close-verify --ref 123 --apply                    # only a MERGED PR/MR is accepted for --apply
```

Dry-run is always safe; `--apply` refuses non-merged PRs/MRs and commits not reachable from the default branch. After any
non-default-branch merge, run close-verify dry-run, review the list, then
apply.

### Tests

```bash
go test ./...                                   # unit (fake runners, hermetic)
go test -tags=integration ./tracker/itest       # real-instance; see tracker/itest/README.md
```
