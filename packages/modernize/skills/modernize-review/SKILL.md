---
name: modernize-review
argument-hint: "[files...]"
description: >
  Review Go and TypeScript/JavaScript code for outdated language features and
  patterns. Identifies deprecated APIs, verbose patterns the language has since
  simplified, and code that can be rewritten with modern syntax while staying
  compatible with the project's target language version. Make sure to use this
  skill whenever the user asks to review code, audit code quality, or check for
  deprecated patterns — especially when working with Go or TypeScript projects,
  even if they don't explicitly mention "modernize".
---

Review Go or TypeScript/JavaScript code for outdated patterns the language has
since replaced with cleaner, safer alternatives. One line per finding.

## Workflow

### 1. Determine language and target version

**Go**: read `go.mod` for the `go <version>` directive.
**TS/JS**: read `tsconfig.json` for `compilerOptions.target` and `package.json` for `engines.node`.

Only flag modernizations available at the project's target version — suggesting
a feature that requires Go 1.24 to a project stuck on Go 1.20 is noise, not help.

- [ ] Language determined
- [ ] Target version recorded

### 2. Load the reference

| Language | Reference file |
|---|---|
| Go | `<skill-dir>/../references/go.md` |
| TypeScript / JavaScript | `<skill-dir>/../references/ts.md` |

Each reference lists modern features grouped by language version with before/after
examples and minimum version requirements. Read the whole file — the patterns are
the checklist. Every pattern in the reference is a candidate to scan for.

- [ ] Reference read

### 3. Scan and report

One line per finding:

```
<file>:L<line>: <tag> <what>. <replacement>.
```

Tags:
- **deprecated:** API or syntax that is deprecated or has been removed. Name the modern replacement.
- **verbose:** N lines can become N/2 with modern syntax. Show the shorter form.
- **stdlib:** Manual implementation of something the stdlib now provides.
- **legacy-syntax:** Valid, but a newer syntax is preferred and cleaner.

**Example output:**
```
services.go:L34: stdlib: manual slice delete via append(x[:i], x[i+1:]...). slices.Delete(x, i, i+1).
utils.ts:L12: verbose: arr[arr.length - 1] for last element. arr.at(-1).
main.go:L88: deprecated: math/rand imported. math/rand/v2.
```

Rank by impact (biggest modernization first). End with:
```
net: -<N> lines possible, <M> patterns outdated.
```
If nothing to modernize: `Already modern.`

## Boundaries

Scope: language-level modernization only. Does NOT check for bugs, security,
performance, or architecture. Does NOT apply fixes (use modernize-fix for that).

"stop modernize-review" to revert.