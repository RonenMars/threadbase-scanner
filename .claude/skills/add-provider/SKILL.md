---
name: add-provider
description: Add a new agent CLI to @threadbase-sh/scanner (ScannerProvider, opt-in roots, fixtures, persistent index). Use when adding Cursor, Codex, Gemini, Amp, cursor-cli, history indexing, ScannerProvider, or when the user says add a provider. Live PTY and phone chips are other repos — see Companions.
---

# Add a provider (scanner)

This package is the **history index** half. It has no HTTP. The streamer hosts the published npm package `@threadbase-sh/scanner`.

Scanner, streamer, and mobile each declare `ProviderName`. They are not linked. Indexing a name here does not start sessions or draw a browse chip.

Canonical wire name: kebab, matching `claude-code` / `codex-cli` (e.g. `cursor-cli`).

Template: `src/providers/codex-cli.ts` and [docs/plans/multi-agent-provider-feasibility.md](../../../docs/plans/multi-agent-provider-feasibility.md).

## Companions

| Half | Repo | Skill |
|---|---|---|
| Live PTY | [`threadbase-streamer`](https://github.com/RonenMars/threadbase-streamer) | [`.claude/skills/add-provider/SKILL.md`](https://github.com/RonenMars/threadbase-streamer/blob/HEAD/.claude/skills/add-provider/SKILL.md) |
| Phone chips | [`threadbase-mobile`](https://github.com/RonenMars/threadbase-mobile) | [`.claude/skills/add-provider/SKILL.md`](https://github.com/RonenMars/threadbase-mobile/blob/HEAD/.claude/skills/add-provider/SKILL.md) |
| History index | `threadbase-scanner` (this repo) | `.claude/skills/add-provider/` |

Scanner-only fills history but cannot start a session. After this PR merges and a release is cut, the streamer raises `@threadbase-sh/scanner` in a **separate** PR — do not fold that bump into a live-runner change.

Worktrees are siblings: `git worktree add ../tb-scanner-worktrees/<slug> -b feat/<slug> origin/main`. Never nest under the repo root.

## Iron rules

1. **Two unions in this repo** must stay in lockstep: `src/providers/provider.ts` `ScannerProviderName` and `src/types.ts` `ProviderName` (+ `ScanOptions`).
2. **No default `$HOME` scan.** Roots are opt-in and absolute (`codexRoots` pattern). Including the provider in `providers` without roots indexes nothing.
3. **`reduceEntry` must not throw** on unknown shapes — ignore them.
4. Identity is `(provider, absolute_path)`. `session_id` is not unique.
5. Default scan stays `["claude-code"]`.

## 1. Name

- `src/providers/provider.ts` `ScannerProviderName`
- `src/types.ts` `ProviderName` + `ScanOptions` (`providers`, plus a new `*Roots` field)

## 2. Provider class

`ScannerProvider`: `discover` / `canParse` / `createEmptyAccumulator` / `reduceEntry` / `finalize`.

- Non-Claude providers use full reparse on change (`indexFileWithProvider`), not Claude's byte-offset fold, unless sessions are huge and you invest in a resumable accumulator.
- Wire discover in `src/scanner.ts` (`discoverWithProviders`) and `src/persistent/index-engine.ts` the same way Codex is gated on `codexRoots`.
- Export from `src/index.ts`. Add `parse<Name>Conversation` if the streamer will page the full transcript.

## 3. Options shape

Follow `codexRoots`: e.g. `cursorRoots?: string[]`.

## 4. Fixtures + tests

`__fixtures__/<wire-name>/` sanitized JSONL (or whatever the format is). Mirror in-memory + persistent tests from `__tests__/persistent-codex.test.ts` and `__tests__/codex-single-file-parse.test.ts`:

- finds files from `*Roots`
- does not index without roots
- `meta.provider` is the new name
- does not steal Claude files (`canParse`)

## 5. Publish, then bump streamer

After merge and npm release, streamer: raise `@threadbase-sh/scanner`, pass `providers: […, newName]` and `*Roots` from `ScannerManager` / `StreamerServer` (see the [streamer skill](https://github.com/RonenMars/threadbase-streamer/blob/HEAD/.claude/skills/add-provider/SKILL.md)). Codex defaults `~/.codex/sessions`; pick an analogous default only if the vendor path is stable and documented.

Until that bump, live sessions can work and the history list stays empty — that is expected.

## Out of scope

HTTP/MCP inside this package. Phone chips — [mobile skill](https://github.com/RonenMars/threadbase-mobile/blob/HEAD/.claude/skills/add-provider/SKILL.md). Live PTY — [streamer skill](https://github.com/RonenMars/threadbase-streamer/blob/HEAD/.claude/skills/add-provider/SKILL.md). VS Code `state.vscdb` / protobuf stores are a different provider variant (feasibility doc) — do not pretend they are JSONL.
