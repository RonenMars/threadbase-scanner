# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@threadbase/scanner` — unified Claude Code conversation history scanner. TypeScript library + CLI that scans `~/.claude/projects/` for JSONL conversation files, extracts metadata, and provides full-text search.

## Commands

- `npm test` — run all tests (vitest)
- `npm run lint` — type-check + Biome lint (`tsc --noEmit && npx biome check .`)
- `npm run format` — auto-format all files (`npx biome format --write .`)
- `npm run check` — lint + format with auto-fix (`npx biome check --write .`)
- `npm run build` — produces `dist/` via tsup (ESM + CJS + types). Also runs automatically as `prepare`.
- Single test: `npx vitest run __tests__/parser.test.ts`

## Architecture

Three layers: **core engine** (src/*.ts) → **API layer** (src/index.ts exports) → **CLI wrapper** (cli/).

The library and CLI are built as separate tsup entries — `src/index.ts` produces `dist/index.js` (ESM) + `dist/index.cjs` (CJS) + types, while `cli/index.ts` produces `dist/cli.js` with a shebang.

Key modules and their responsibilities:
- `discovery.ts` — fast-glob `**/*.jsonl` with `/memory/` and `/tool-results/` exclusions
- `parser.ts` — JSONL line-by-line streaming with `parseMeta()` (lightweight) and `parseConversation()` (full)
- `indexer.ts` — FlexSearch document index across all metadata fields (legacy in-memory search)
- `filters.ts` — immutable sort/filter/pagination (returns new arrays, never mutates)
- `scanner.ts` — orchestrator/facade. Persistent (SQLite) by default; pass `persistent: false` for the legacy in-memory path
- `providers/` — `ScannerProvider` abstraction (discover/canParse/reduce/finalize). `ThreadbaseProvider` wraps the shared `metadata-reducer` (no duplication); `CodexCliProvider` parses local OpenAI Codex CLI rollout sessions into the same `ConversationMeta` model

### Providers (`src/providers/`)

Both the Claude/Threadbase format and local Codex CLI history flow through one normalized provider pipeline. Codex is **opt-in** via `scan({ providers: ['claude-code', 'codex-cli'], codexRoots: [...] })` — no home directory is scanned by default; `codexRoots` must be absolute.

**Codex is indexed in both the in-memory and SQLite persistent engines.** A persistent-mode scan/search with `providers: ['codex-cli']` + `codexRoots` discovers Codex files through the `CodexCliProvider`, reduces them via the shared provider pipeline, and upserts them into the same `conversations`/FTS tables as Threadbase. Threadbase files keep the byte-offset-resumable incremental fold; Codex files reparse from offset 0 on each change (rollout sessions are small — see the `ponytail:` note in `index-engine.ts` for the upgrade path). Persisted rows carry a `provider` column (schema v3); canonical identity is `(provider, absolute_path)` and `session_id` stays non-unique, resolved newest-timestamp-first.

### Persistent engine (`src/persistent/`)

The scanner is **SQLite-backed by default** (`better-sqlite3`, WAL mode). A `ConversationScanner` writes a durable index at `~/.config/threadbase-scanner/index.db` (override with `persistent: { dbPath }`, or the `TB_SCANNER_DB` env var; opt out with `persistent: false` / CLI `--no-persist`).

- `index-engine.ts` — discover → classify → tail-read → upsert; queries read straight from SQLite
- `cursor.ts` + `jsonl-tail-reader.ts` — byte-offset incremental indexing: an appended file re-reads only the new bytes (O(Δ)); truncate/replace reindexes from 0
- `metadata-reducer.ts` / `conversation-reducer.ts` — serializable per-line folds shared by `parser.ts` and the incremental/bounded readers (so a streamed parse and a resumed parse are identical by construction)
- `paged-reader.ts` + `message_checkpoints` — bounded `getConversationPage` that seeks from the nearest checkpoint and reads only the window. Checkpoints are **append-only** (Kafka sparse-index style): an append extends the chain past the previous EOF; rows are dropped only on truncate/replace
- `conversation-stream.ts` — resumable full-conversation parse backing the scanner's LRU: `refreshFile()` on an appended file folds only the new bytes into the cached `Conversation` instead of evicting it. `refreshFile()` and checkpoint builds are single-flighted per path (concurrent callers share one parse)
- `parseJsonlLine()` (public export) — stateless per-line line→message mapping (the same reducer used internally) for downstream indexers tailing appended lines
- `repositories/fts.repo.ts` — SQLite FTS5 search backend (persistent-mode `search()`)
- `sidecar.ts` — optional `<file>.idx.json` (off by default, `persistent: { sidecar: true }`)
- `src/watcher/` — optional chokidar watcher + debounced single-writer index queue + periodic rescan backstop; emits `change`/`error` events (`scanner.watch()` / `on()`)

Parity is enforced: `__tests__/persistent-scan.test.ts` asserts identical `ScanResult` between the persistent and legacy paths across the option matrix.

### Distribution model

Published to **public npm** as `@threadbase-sh/scanner` (semantic-release). `dist/` is gitignored and built by the `prepare` script. Note `better-sqlite3` is a native dependency (ships prebuilt binaries; falls back to node-gyp).

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

## Merging PRs — Rebase + Squash, Linear History

Keep `main` a straight line — one commit per PR, no merge commits. Every PR follows the same two operations, in this order:

1. **Rebase onto latest `main`** to sync before merging. `git fetch origin && git rebase origin/main`, resolve conflicts preserving the PR's intent, then `git push --force-with-lease` (never plain `--force`, never force-push `main`). This guarantees no merge commit sneaks in.
2. **Squash-merge** the rebased PR: `gh pr merge <N> --squash --delete-branch`. The squash title must be conventional-commit compliant and carry no AI attribution.

Rules:

- **One PR at a time.** Never sync/merge PRs in parallel — rebase one, wait for its CI to go green, squash-merge it, then move to the next. A just-merged PR advances `main`, so the next PR is usually behind and must be rebased again.
- **Dependency order first.** If PR B is stacked on PR A (GitHub shows A's branch as B's base), merge A before B and rebase B onto the updated `main` afterward.
- **CI gate.** Only squash-merge when required checks are green. If CI is red on a flaky/infra failure, re-run it **once**; if the re-run still fails, stop and report — do not merge red.
- **Stuck cap.** If any single step hangs for more than ~3–4 minutes (CI not progressing, a rebase that won't resolve cleanly), stop and report rather than waiting indefinitely.
