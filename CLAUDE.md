# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@threadbase/scanner` — unified Claude Code conversation history scanner. TypeScript library + CLI that scans `~/.claude/projects/` for JSONL conversation files, extracts metadata, and provides full-text search.

## Commands

- `npm test` — run all tests (vitest, 124 tests across 12 files)
- `npm run lint` — type-check + Biome lint (`tsc --noEmit && npx biome check .`)
- `npm run format` — auto-format all files (`npx biome format --write .`)
- `npm run check` — lint + format with auto-fix (`npx biome check --write .`)
- `npm run build` — produces `dist/` via tsup (ESM + CJS + types). Also runs automatically as `prepare` when this repo is installed as a git URL dependency.
- Single test: `npx vitest run __tests__/parser.test.ts`

## Architecture

Three layers: **core engine** (src/*.ts) → **API layer** (src/index.ts exports) → **CLI wrapper** (cli/).

The library and CLI are built as separate tsup entries — `src/index.ts` produces `dist/index.js` (ESM) + `dist/index.cjs` (CJS) + types, while `cli/index.ts` produces `dist/cli.js` with a shebang.

Key modules and their responsibilities:
- `discovery.ts` — fast-glob `**/*.jsonl` with `/memory/` and `/tool-results/` exclusions
- `parser.ts` — JSONL line-by-line streaming with `parseMeta()` (lightweight) and `parseConversation()` (full)
- `indexer.ts` — FlexSearch document index across all metadata fields
- `filters.ts` — immutable sort/filter/pagination (returns new arrays, never mutates)
- `scanner.ts` — orchestrator that wires discovery → parser → indexer with batching and caching

### Distribution model

This package is consumed via **npm's git URL dependency** mechanism, not via npm publish. Consumers declare `"@threadbase/scanner": "github:RonenMars/threadbase-scanner#<tag>"` in their `package.json`. On install, npm clones this repo at the specified tag, runs `prepare` (which runs `npm run build` → `tsup`), and the resulting `dist/` is what consumers `require`/`import`.

`dist/` is gitignored — it's only ever produced by the `prepare` script during install (or by hand during local development). The `prepare` script is what makes this distribution model work.

A previous attempt at publishing to npm with V8 bytecode (`bytenode`) protection was abandoned after discovering bytenode `.jsc` files are not cross-platform. See `docs/plans/bytenode-npm-package.md` for the full lessons-learned record.

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
