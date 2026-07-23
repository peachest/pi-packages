---
name: modernize-fix
argument-hint: "[files...]"
description: >
  Automatically detect and fix outdated language features in Go and
  TypeScript/JavaScript code. Applies modern syntax replacements while
  respecting the project's target language version. Make sure to use this
  skill whenever the user asks to fix or update code, apply modern syntax,
  or upgrade a codebase — especially when they're working with Go or
  TypeScript files and the code looks like it was written for an older
  version of the language.
---

Apply modern syntax replacements to Go or TypeScript/JavaScript source files.
Respects the project's target language version — only applies fixes available
at that version to avoid breaking the build.

## Workflow

### 1. Discover scope

Check what the user wants:
- A single file: `modernize fix path/to/file.go`
- A directory: `modernize fix ./pkg/`
- Changed files since a ref: `modernize fix --diff main`

Default to the **current active file** if not specified.

- [ ] Scope determined

### 2. Read project config

- **Go**: read `go.mod` for the `go <version>` directive
- **TS/JS**: read `tsconfig.json` for `compilerOptions.target` and `package.json` for `engines.node`

This determines the minimum language version. Any replacement requiring a newer
version is skipped — a fix that breaks compilation is worse than the original code.

- [ ] Target version recorded

### 3. Load the reference

| Language | Reference file |
|---|---|
| Go | `<skill-dir>/../references/go.md` |
| TypeScript / JavaScript | `<skill-dir>/../references/ts.md` |

Each reference lists all modern features with before/after examples and minimum
version. Read the whole file — those patterns are your fix checklist.

- [ ] Reference read

### 4. Apply fixes

For each file in scope, apply replacements from the reference that are available
at the project's target version.

**Go:** If Go 1.26+, run `go fix ./...` first — Go 1.26 rewrote `go fix` as a
comprehensive modernizer suite that handles most common patterns automatically.
Then apply any remaining manual replacements from the reference.

**TS/JS:** No equivalent of `go fix` exists. Apply all matching replacements
manually from `references/ts.md`.

After each file, check the diff to make sure the replacement didn't introduce
syntax errors or change semantics.

### 5. Verify

- **Go**: run `go build ./...` or `go vet ./...`
- **TS/JS**: run `tsc --noEmit`

If compilation fails, roll back the breaking change and report which replacement
caused it. A fix that breaks the build is not a fix.

- [ ] Build/type-check passes

### 6. Report

```
modernize-fix: <N> files updated, -<L> lines.
```

If nothing to fix: `Already modern.`

## Boundaries

Only language-level syntax and API changes. Does not refactor logic, restructure
code, or upgrade dependencies. `stop modernize-fix` to revert.