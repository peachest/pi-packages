# TypeScript / JavaScript Modern Features

Check `tsconfig.json` for `compilerOptions.target` and `compilerOptions.module`.
Check `package.json` for `engines.node` to determine available ES features.

## TypeScript 4.x

- **Variadic tuple types** — `[...T, ...U]` replaces manual overloads for variadic functions
- **Template literal types** — `` `${Key}Id` `` type manipulation
- **Key remapping in mapped types** — `{ [K in Key as \`get${K}\`]: T[K] }`
- **const type parameters** — `function f<const T>(x: T)` infers literal types through generics
- **Satisfies operator** (4.9+) — `const x = { a: 1 } satisfies Record<string, number>` — checks type without widening

## TypeScript 5.0

- **Decorators (standard)** — use TC39 decorators (`@decorator`) instead of experimental `experimentalDecorators` flag
- **`const` type parameter** (stabilized)
- **`export type *`** — re-export types only from a module

## TypeScript 5.2

- **`using` declarations** — `using x = getResource()` for explicit resource management (TC39)
- **`await using`** — async disposables
- **Decorator metadata** — `Symbol.metadata` support

## TypeScript 5.3

- **Import attributes** — `import x from "x" with { type: "json" }` instead of deprecated `assert` syntax
- **`switch(true)` narrowing** — type narrowing inside `switch(true)` cases

## TypeScript 5.4

- **NoInfer utility type** — `NoInfer<T>` to block inference from a position
- **Improved narrowing** — last-assignment narrowing for parameters and `let` variables in non-hoisted functions

## TypeScript 5.5

- **Inferred type predicates** — `function isStr(x: unknown) { return typeof x === "string" }` auto-becomes a type predicate
- **Control flow narrowing for `Set.has()`** — `set.has(x)` narrows `x`
- **JSDoc `@import` tag** — `/** @import { Foo } from "./foo" */` in JS files
- **`isolatedDeclarations`** — generate `.d.ts` without full type checking
- **Regular expression syntax checking** — catches invalid regex literals

## TypeScript 5.6

- **`--noUncheckedSideEffectImports`** — errors on side-effect imports that can't be resolved
- **`--strictBuiltinIteratorReturn`** — stricter types for built-in iterator returns
- **Disallowed nullish/truthy checks** — catches accidental `if (result)` where nullish was intended

## TypeScript 5.7

- **Improved variable initialization checks** — errors on never-initialized variables
- **ECMAScript module support improvements**

## Quick Reference (TS)

| Old pattern | Modern replacement | Since |
|---|---|---|
| `try { x = get() } finally { x.cleanup() }` | `using x = get()` | TS 5.2 |
| `as Foo` widening workaround | `satisfies Foo` | TS 4.9 |
| `function isX(x): x is X { ... }` (manual guard) | auto-inferred type predicates, remove annotation | TS 5.5 |
| `{ [K in keyof T]: V }` | `{ [K in keyof T as \`map${K}\`]: V }` | TS 4.1 |
| JSDoc `@type {import("./foo").Foo}` inline | `@import { Foo } from "./foo"` once | TS 5.5 |
| `expDecorators: true` + `@decorator` | no flag + standard decorators | TS 5.0 |
| `import x from "x" assert { type: "json" }` | `import x from "x" with { type: "json" }` | TS 5.3 |

## JavaScript — ES2022+

| Feature | Replaces | Available since |
|---|---|---|
| `.at(-1)` | `arr[arr.length - 1]` | ES2022 (Node 16.6+) |
| `structuredClone(obj)` | `JSON.parse(JSON.stringify(obj))` | ES2022 (Node 17+) |
| Top-level `await` | IIFE `await` wrapper | ES2022 (Node 16.4+) |
| `import.meta.dirname` / `import.meta.filename` | `fileURLToPath` + `dirname` boilerplate | Node 20.11+ / 21.2+ |
| `Promise.withResolvers()` | manual `new Promise((res,rej)=>{...})` boilerplate | ES2024 (Node 22+) |
| `Object.groupBy(arr, fn)` | manual `reduce` grouping loop | ES2024 (Node 21+) |
| `Map.groupBy(iter, fn)` | manual `reduce` + Map | ES2024 (Node 21+) |