---
name: add-provider
description: Add a new agent CLI to @threadbase-sh/scanner (ScannerProvider, opt-in roots, fixtures, persistent index). Use when adding Cursor, Codex, Gemini, Amp, Aider, OpenCode, Goose, ClawCode, Hermes, cursor-cli, history indexing, ScannerProvider, or when the user says add a provider. Live PTY and phone chips are other repos — see Companions.
---

# Add a provider (scanner)

This package is the **history index** half. It has no HTTP. The streamer hosts `@threadbase-sh/scanner`. Indexing a name here does not start sessions or draw a browse chip.

Canonical wire name: kebab, matching streamer/mobile (`cursor-cli`, `gemini-cli`, `opencode`, `goose`, `aider`).

Template: `src/providers/codex-cli.ts`. Format difficulty and agent table: [docs/plans/multi-agent-provider-feasibility.md](../../../docs/plans/multi-agent-provider-feasibility.md). **Read that matrix before choosing a parse strategy.**

## Companions

| Half | Repo | Skill |
|---|---|---|
| Live PTY | [`threadbase-streamer`](https://github.com/RonenMars/threadbase-streamer) | [`.claude/skills/add-provider/SKILL.md`](https://github.com/RonenMars/threadbase-streamer/blob/HEAD/.claude/skills/add-provider/SKILL.md) |
| Phone chips | [`threadbase-mobile`](https://github.com/RonenMars/threadbase-mobile) | [`.claude/skills/add-provider/SKILL.md`](https://github.com/RonenMars/threadbase-mobile/blob/HEAD/.claude/skills/add-provider/SKILL.md) |
| History index | `threadbase-scanner` (this repo) | `.claude/skills/add-provider/` |

**Keep companions in sync.** These three skills are one workflow. Changing this file (intake rules, wire-name convention, land order, companion links, or out-of-scope) means updating the other two in the same change set — PRs in `threadbase-streamer`, `threadbase-mobile`, and `threadbase-scanner`. Do not leave a companion on stale steps or a moved path.

After merge and npm release, streamer raises `@threadbase-sh/scanner` in a **separate** PR. Until then live sessions can work with an empty history list.

Worktrees are siblings: `git worktree add ../tb-scanner-worktrees/<slug> -b feat/<slug> origin/main`.

## 0. Vendor intake — pick a parse strategy

| On-disk shape | Examples | Do |
|---|---|---|
| Append-only JSONL / stable JSON files | Gemini CLI, Cursor **agent-transcripts**, Aider dumps, Amp threads | Codex template (`discover` files, full reparse). |
| One directory per session | Grok CLI | `discover` dirs; `ConversationMeta.id` = canonical session path. |
| SQLite (or JSON + SQLite) | OpenCode, Goose, Copilot Chronicle | Same `ScannerProvider` contract, **not** a byte-cursor fold. Read-only / copy-on-read if the IDE locks the DB. Prefer one store when dual layouts exist (OpenCode SQLite over legacy JSON). |
| VS Code `state.vscdb` / protobuf | Cursor Composer, Antigravity `.pb` | **Do not** pretend this is JSONL. Stop and say it needs a store/protobuf variant (feasibility Phase 3). Skip v1 unless the user insists. |
| No local transcript | Some CLIs only keep RAM/remote | History-only is impossible; live PTY can still ship in the streamer. |

Do not glob `$HOME`. Roots stay caller-supplied and absolute.

Double-count traps (document the preference in the PR): Cursor agent-transcripts vs Composer; Copilot CLI vs VS Code Chat; OpenCode SQLite vs legacy JSON.

## Iron rules

1. **Two unions in lockstep:** `src/providers/provider.ts` `ScannerProviderName` and `src/types.ts` `ProviderName` (+ `ScanOptions`).
2. **No default `$HOME` scan.** `providers` without `*Roots` indexes nothing.
3. **`reduceEntry` must not throw** on unknown shapes.
4. Identity is `(provider, absolute_path)` (or a documented path-like store key). `session_id` is not unique.
5. Default scan stays `["claude-code"]`.
6. Default new providers to **full reparse on change**. Only append-only JSONL with a serializable accumulator may grow a byte cursor later.

## 1. Name

- `ScannerProviderName` + `ProviderName` + `ScanOptions.*Roots` (mirror `codexRoots`).

Today Codex is hard-wired in `scanner.ts` / `index-engine.ts`. A new provider adds another gated `if` like Codex. Do not build a generic registry unless the user asked — but do not copy Claude's resumable fold into a SQLite agent.

## 2. Provider class

`discover` / `canParse` / `createEmptyAccumulator` / `reduceEntry` / `finalize`.

- Wire `discoverWithProviders`, `indexAll`, `resolveProviderForFile`, get-conversation/page.
- Export from `src/index.ts`. Add `parse<Name>Conversation` when the format is not Threadbase JSONL.

## 3. Fixtures + tests

`__fixtures__/<wire-name>/` sanitized samples (JSONL, JSON, or a tiny SQLite). Mirror `__tests__/persistent-codex.test.ts`:

- finds from `*Roots`; nothing without roots
- `meta.provider` is the new name
- `canParse` does not steal Claude/Codex files
- search `provider` filter; deletion + refresh

## 4. Publish, then bump streamer

Streamer: bump `@threadbase-sh/scanner`, pass `providers` + `*Roots` from `ScannerManager` (see [streamer skill](https://github.com/RonenMars/threadbase-streamer/blob/HEAD/.claude/skills/add-provider/SKILL.md)). Default a root only if the vendor path is stable and documented.

README must list the new opt-in roots.

## Out of scope

HTTP/MCP in this package. Phone chips — [mobile](https://github.com/RonenMars/threadbase-mobile/blob/HEAD/.claude/skills/add-provider/SKILL.md). Live PTY — [streamer](https://github.com/RonenMars/threadbase-streamer/blob/HEAD/.claude/skills/add-provider/SKILL.md).
