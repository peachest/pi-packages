> [中文文档](./docs/README.zh.md) · English

# modernize

> Automatically detect and fix outdated language features in Go and TypeScript/JavaScript code.

A [pi](https://github.com/earendil-works/pi-coding-agent) package that keeps your codebase speaking the current dialect — writing modern syntax proactively, reviewing for outdated patterns, and auto-fixing them.

## Skills

### `modernize-fix`

Automatically detect and fix outdated language features in Go and TypeScript/JavaScript code. Applies modern syntax replacements while respecting the project's target language version.

Trigger: whenever you ask pi to fix or update code, apply modern syntax, or upgrade a codebase.

### `modernize-review`

Review Go and TypeScript/JavaScript code for deprecated APIs, verbose patterns the language has since simplified, and code that can be rewritten with modern syntax while staying compatible with the project's target version.

Trigger: whenever you ask pi to review code, audit quality, or check for deprecated patterns.

## Reference

- [Go modern features](./references/go.md) — per-version changelog from Go 1.21 to 1.26, with a quick-reference table of old → modern replacements
- [TypeScript / JavaScript modern features](./references/ts.md) — per-version changelog from TS 4.x to 5.7, plus ES2022+ JavaScript features with Node compatibility notes

## Background

Existing review tools (simplify skill, open-code-review, ponytail) catch code quality and simplification issues well, but none specifically identify **correct but outdated** language features. An agent might produce perfectly valid Go 1.19 code in a 1.24 project — no bugs, no simplification needed, just using patterns the language has since given better alternatives for.

This package fills that gap: it knows what modern syntax each language version supports and flags (or rewrites) code that falls behind. For Go projects on 1.26+, it also leverages `go fix` as the canonical modernizer. For TypeScript/JavaScript, the transformations are determined from the project's `tsconfig.json` target and `engines.node`.

## Install

```bash
pi install /path/to/modernize
```

Or install from npm (if published):

```bash
pi install npm:modernize
```

## Test

```bash
npm test
```
