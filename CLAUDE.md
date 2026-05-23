# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@ronenmars/threadbase-scanner` — unified Claude Code conversation history scanner. TypeScript library + CLI that scans `~/.claude/projects/` for JSONL conversation files, extracts metadata, and provides full-text search.

## Commands

- `npm test` — run all tests (vitest, 124 tests across 12 files)
- `npm run lint` — type-check + Biome lint (`tsc --noEmit && npx biome check .`)
- `npm run format` — auto-format all files (`npx biome format --write .`)
- `npm run check` — lint + format with auto-fix (`npx biome check --write .`)
- `npm run build` — two-stage build: tsup → bytenode (outputs `dist/<loaders>` + `dist/node-<major>/*.jsc`)
- `npm run build:tsup` — just tsup, no bytenode (debugging)
- `npm run build:bytenode` — just bytenode on existing `dist/` (debugging)
- Single test: `npx vitest run __tests__/parser.test.ts`

## Architecture

Three layers: **core engine** (src/*.ts) → **API layer** (src/index.ts exports) → **CLI wrapper** (cli/).

### Build pipeline — two stages

1. **`tsup`** produces bundled JS in `dist/`: `index.cjs` (CJS), `index.js` (ESM), `cli.cjs` (CJS with shebang), `index.d.ts`, `index.d.cts`. The CLI is emitted as CJS (not ESM, as it was historically) so bytenode can compile it.

2. **`scripts/build-bytenode.mjs`** compiles the CJS outputs to V8 bytecode under `dist/node-<major>/{index,cli}.jsc`, deletes the bundled JS source files, and installs small dispatching loaders (`src/loader/*`) in their place as `dist/index.cjs`, `dist/index.js`, `dist/cli.cjs`. Each loader inspects `process.versions.node` at runtime and `require`s the matching `.jsc`.

The published npm tarball contains **only bytecode + loaders + types** — never the bundled scanner source. Local builds produce a `dist/` with one `node-<current>/` directory; CI's release matrix (`.github/workflows/release.yml`) produces all five (`node-22/` through `node-26/`) and merges them in the publish job via `scripts/assemble-dist.mjs`.

### Supported Node versions

The release matrix is `[22, 23, 24, 25, 26]`. Three places define this — keep them in sync when bumping:

1. `.github/workflows/release.yml` — `compile` job's matrix
2. `.github/workflows/ci.yml` — `test` job's matrix
3. `scripts/assemble-dist.mjs` — `EXPECTED_MAJORS` constant

Users on unsupported Node majors hit a hard error at module load — there is no plain-JS fallback. `engines.node` in `package.json` is `>=22` so `npm install` also warns up front.

Key modules and their responsibilities:
- `discovery.ts` — fast-glob `**/*.jsonl` with `/memory/` and `/tool-results/` exclusions
- `parser.ts` — JSONL line-by-line streaming with `parseMeta()` (lightweight) and `parseConversation()` (full)
- `indexer.ts` — FlexSearch document index across all metadata fields
- `filters.ts` — immutable sort/filter/pagination (returns new arrays, never mutates)
- `scanner.ts` — orchestrator that wires discovery → parser → indexer with batching and caching
- `loader/*` — the tiny `.cjs`/`.js` files that ship to npm as the package's `main`/`module`/`bin` entrypoints. They dispatch to `dist/node-<major>/*.jsc` at runtime; on miss they throw with the supported-majors list. The ESM loader (`loader/index.js`) hand-enumerates named exports so it can re-export them from the CJS-only `.jsc` — when adding a new runtime export to `src/index.ts`, also add it to the destructure list in `loader/index.js`.

## Code Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, etc.)
- Every new feature must have integration or e2e tests in `__tests__/`
- Test fixtures go in `__fixtures__/` as real JSONL files
- Vitest globals are enabled — no need to import `describe`, `it`, `expect`
- FlexSearch has inconsistent ESM/CJS default exports — the indexer uses `any` typing as a workaround. Do not try to fix the FlexSearch types.
- All filter/sort functions must be immutable (return new arrays). This is intentional — apps hold references.

## Testing

Tests use real filesystem operations (temp directories via `mkdtempSync`). Each test creates and cleans up its own fixtures. The `__fixtures__/` directory has shared JSONL files for parser tests.

Run the full verification before committing: `npm run lint && npm test`
