# Phase 2: Persist Codex CLI Conversations in SQLite

Use this prompt in the `threadbase-scanner` repository after the Codex CLI provider PR is opened.

## Task — New worktree for Phase 2: persist Codex conversations in SQLite

Create a new worktree for Phase 2.

Do not modify `.worktrees/codex-cli-provider` directly after the PR is opened.

Create a new worktree and branch, for example:

- worktree: `.worktrees/codex-sqlite-persistence`
- branch: `feat/codex-sqlite-persistence`

Base this new branch on the Codex provider branch, because Phase 2 needs both:

- the persistent SQLite engine work
- the provider-aware Codex CLI work

Use the cleanest available base:

1. Prefer `feat/codex-cli-provider` if it contains the SQLite engine work plus Codex provider work.
2. Otherwise inspect branches and choose the branch that contains both sets of changes.
3. If unsure, stop and summarize the branch situation before editing.

## Phase 2 goal

Make local Codex CLI conversations persistent in the SQLite engine.

Currently:

```txt
In-memory scanner:
  Threadbase ✅
  Codex CLI ✅

Persistent SQLite scanner:
  Threadbase ✅
  Codex CLI ❌ / not wired
```

After this task:

```txt
In-memory scanner:
  Threadbase ✅
  Codex CLI ✅

Persistent SQLite scanner:
  Threadbase ✅
  Codex CLI ✅
```

## Important constraints

- Do not add new required dependencies.
- Do not add `better-sqlite3` if it is not already part of the SQLite engine work.
- Preserve the existing public scanner API.
- Keep Codex scanning opt-in through `codexRoots` / provider options.
- Do not scan arbitrary home directories by default.
- Do not duplicate parser logic.
- The persistent engine must use the provider reducer/finalize pipeline.
- `sessionId` must remain non-unique.
- Canonical identity must be based on provider + normalized absolute path.
- Unknown Codex event shapes must never crash the full scan.

## Implementation requirements

### 1. Inspect current persistent engine

Before editing, inspect:

- SQLite schema and migrations
- persistent scanner entrypoint
- file cursor logic
- refresh logic
- search/FTS logic
- existing SQLite tests
- provider-aware scanner changes from Phase 1

Then summarize the minimal implementation plan before making changes.

### 2. Update SQLite schema if needed

Ensure the persistent tables can represent multiple providers.

At minimum, persisted conversation/file rows need:

```txt
provider
absolute_path
session_id / external_session_id
project_path / cwd
branch
model
kind
message_count
first_sent_at
first_sent_text
last_sent_at
last_sent_text
last_assistant_text / preview
tool_names
last_indexed_offset / last_indexed_line if supported
size_bytes
mtime
deleted_at
updated_at
```

Use whatever naming matches the existing schema, but the important identity rule is:

```txt
PRIMARY identity = provider + absolute_path
```

Do not create a unique index on `session_id`.

Add or update indexes for:

```txt
provider + absolute_path
provider + session_id
provider + last_sent_at / updated_at
provider + project_path + branch
```

If migrations exist, add a migration. Do not destructively reset user data.

### 3. Wire provider discovery into persistent scan

The persistent scanner should not call a Threadbase-specific parser directly.

It should:

```txt
enabled providers
  ↓
provider discovery
  ↓
provider canParse / parse
  ↓
normalized ConversationMeta
  ↓
SQLite upsert
  ↓
SQLite search/FTS indexing
```

Codex should be included only when enabled through options, for example:

```ts
providers: ["threadbase", "codex-cli"],
codexRoots: [...]
```

### 4. Persist Codex metadata

For Codex CLI conversations, persist the metadata already extracted by the Codex provider:

- provider: `"codex-cli"`
- kind
- file path id
- sessionId / externalSessionId
- cwd / project path
- branch
- model
- tool names
- message count
- first user text/time
- last user text/time
- last assistant text
- preview/snippet
- updated timestamp

Make sure persisted Codex conversations appear in the same list/query APIs as Threadbase conversations.

### 5. Refresh and deletion behavior

Update persistent refresh behavior so that:

- `refreshFile(filePath)` works for Codex files.
- The provider can be resolved from stored metadata or by `canParse`.
- Updating a Codex JSONL file updates its SQLite row.
- Deleting/dropping one file does not hide another active file with the same `sessionId`.
- Duplicate `sessionId` resolution remains deterministic:
  1. exact file path match wins
  2. otherwise match by sessionId
  3. newest timestamp wins
  4. tie-break by absolute path ascending

### 6. Search behavior

Persistent search should include Codex conversations.

If provider filtering exists in the in-memory scanner, support equivalent filtering in the persistent path:

```ts
scanner.search("query", { provider: "codex-cli" })
scanner.search("query", { provider: "threadbase" })
```

If the persistent engine uses FTS, ensure Codex text is indexed.

### 7. Tests

Add tests proving Codex works in persistent SQLite mode.

Required cases:

- persistent scan finds Codex files from `codexRoots`
- Codex rows are stored in SQLite
- persisted Codex metadata includes provider, model, branch, preview, message count
- persistent `getConversation(filePath)` works for Codex
- persistent `getConversation(sessionId)` works for Codex
- duplicate session IDs are non-unique and deterministic
- deleting one duplicate-session file does not hide the other
- persistent search finds Codex text
- provider search filter works in persistent mode
- existing Threadbase SQLite tests still pass

Use the existing Codex fixtures from Phase 1 where possible.

### 8. Optional smoke test

If local `~/.codex` data exists, run a smoke test against it, but do not make tests depend on real local data.

Expected smoke-test result:

```txt
Persistent SQLite scanner indexes real local Codex sessions and can fetch/search them from SQLite.
```

## Validation

Run:

- typecheck
- lint
- tests
- build

Use the repo’s actual package manager.

## Deliverable

When done, commit the Phase 2 work on `feat/codex-sqlite-persistence`.

Suggested commit message:

```txt
feat: persist Codex CLI conversations in SQLite
```

Do not open the Phase 2 PR until validation passes. If validation fails, stop and summarize the failure with the exact command output and likely fix.
