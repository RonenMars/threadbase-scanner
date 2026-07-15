# Threadbase Scanner: Add Local Codex CLI Provider Support

Use this as the implementation prompt inside the `threadbase-scanner` repo:

```md
You are working in the existing `threadbase-scanner` codebase.

Goal: evolve the current scanner so the same codebase can index both the existing Threadbase/Claude-style local conversation history and local OpenAI Codex CLI history.

Do not create a separate scanner project. Keep the current package/API shape as much as possible, and introduce provider support inside the existing architecture.

## Current constraints to preserve

Preserve the current public behavior unless explicitly noted:

- `id` is currently the file path.
- `getConversation(id)` resolves by file path first, then by `sessionId`.
- `sessionId` is not guaranteed unique.
- The stable canonical identity must be the normalized absolute file path.
- Existing scanner APIs should keep working:
  - `scan`
  - `search`
  - `getConversation`
  - `refreshFile`
  - `getConversationPage`
  - existing metadata fields and search behavior where possible.

Do not add `better-sqlite3` as a required dependency of the main public package. Native SQLite can be introduced only behind an optional storage adapter or separate package later. For this task, prefer changes that keep install ergonomics safe for public npm consumers.

## Desired architecture

Refactor the scanner around a provider model.

Add a provider abstraction similar to:

```ts
export type ScannerProviderName = "threadbase" | "codex-cli";

export interface ScannerProvider {
  name: ScannerProviderName;

  discover(options: ProviderDiscoveryOptions): Promise<DiscoveredConversationFile[]>;

  canParse(filePath: string, sample?: string): Promise<boolean> | boolean;

  createEmptyAccumulator(context: ParseContext): ConversationAccumulator;

  reduceEntry(
    accumulator: ConversationAccumulator,
    entry: unknown,
    context: ParseContext
  ): ConversationAccumulator;

  finalize(
    accumulator: ConversationAccumulator,
    context: ParseContext
  ): ConversationMeta;
}
```

The exact shape can be adjusted to match the current codebase, but the important design requirement is:

> Full parsing and incremental parsing must use the same reducer logic.

The existing parser should not be duplicated. Refactor the current `parseMeta` loop body into reusable accumulation/reducer functions, then make the existing Threadbase/Claude parser one provider implementation.

## Provider responsibilities

### Threadbase / existing provider

Wrap the current behavior in a provider named something like:

```ts
ThreadbaseProvider
```

or:

```ts
ClaudeProvider
```

Use whichever name fits the current codebase terminology best.

This provider should preserve current fixture behavior except where duplicate `sessionId` semantics are intentionally corrected.

### Codex CLI provider

Add a local Codex CLI provider named:

```ts
CodexCliProvider
```

This provider should support local Codex CLI history files.

Important: do not hardcode fragile assumptions about the Codex CLI file format. Implement the provider defensively:

- discover candidate files from configurable roots
- sample the first few lines to determine whether a file looks like Codex CLI history
- parse JSONL / NDJSON-like event logs line by line
- ignore unknown event shapes safely
- extract metadata opportunistically
- never crash the whole scan because one Codex event shape is unknown

Add scanner options like:

```ts
type ScannerOptions = {
  providers?: ScannerProviderName[];
  roots?: string[];
  threadbaseRoots?: string[];
  codexRoots?: string[];
};
```

Exact naming can follow existing style.

The Codex provider should normalize local Codex events into the existing `ConversationMeta` model as much as possible.

Try to extract:

- canonical id: absolute file path
- provider: `"codex-cli"`
- sessionId / externalSessionId if present
- project path / cwd / repo path if present
- git branch using existing git helper if project path is known
- model if present
- first user message datetime/text
- last user message datetime/text
- last assistant message datetime/text
- total message count
- tool names if present
- last updated timestamp
- preview/snippet

If Codex has task-oriented events rather than plain chat messages, still normalize them into the existing conversation model for now. Add optional fields only if needed, for example:

```ts
provider?: "threadbase" | "codex-cli";
kind?: "conversation" | "task";
externalSessionId?: string;
```

Avoid large type churn unless required.

## Identity and sessionId collision behavior

Canonical identity must be:

```txt
provider + absolute_path
```

For current in-memory behavior, if the code still uses file path as `id`, preserve that externally.

`sessionId` must not be unique.

Resolution behavior for `getConversation(id)`:

1. exact file path / canonical id match wins
2. otherwise resolve by `sessionId`
3. if multiple active rows/metas share the same `sessionId`, pick deterministically:
   - latest `lastMessageAt` / `updatedAt` first
   - tie-break by absolute path ascending

Add or expose a collision-safe API if it fits the codebase:

```ts
getConversationsBySessionId(sessionId: string): ConversationMeta[]
```

Do not reproduce the old accidental bug where dropping one file can hide another active file with the same `sessionId`.

## Search behavior

Search should work across both providers.

Add provider filtering if straightforward:

```ts
scanner.search("query", { provider: "codex-cli" })
scanner.search("query", { provider: "threadbase" })
```

If the current search API does not support options, avoid breaking it. Add an overload or optional parameter.

Search results should include provider information when available.

## Discovery behavior

Keep existing discovery for current Threadbase/Claude files.

Add Codex discovery as opt-in first, unless the existing scanner already has a safe default-root mechanism.

Recommended behavior:

```ts
new Scanner({
  providers: ["threadbase", "codex-cli"],
  codexRoots: ["/path/to/local/codex/history/root"]
});
```

Do not scan arbitrary large home directories by default.

If default Codex roots are added, make them explicit, documented, and easy to disable.

## Incremental-read compatibility

Structure the provider/parser so it can later support persistent indexing by file offset.

For now, this task does not need to implement SQLite.

But the parser should be designed so a future persistent engine can call:

```ts
readJsonlFromOffset(filePath, lastIndexedOffset)
```

and feed each new line through the same provider reducer.

Avoid parser code that requires loading a full 200MB JSONL file into memory.

## Tests to add/update

Add tests for provider architecture:

- existing Threadbase fixtures still scan
- existing search behavior still works
- `getConversation(filePath)` still works
- `getConversation(sessionId)` still works
- duplicate `sessionId` does not assume uniqueness
- dropping/removing one file does not hide another active file with the same `sessionId`

Add Codex CLI fixtures:

```txt
fixtures/codex-cli/basic-session.jsonl
fixtures/codex-cli/session-with-tools.jsonl
fixtures/codex-cli/unknown-events.jsonl
fixtures/codex-cli/multiple-sessions-same-session-id.jsonl
```

Use small anonymized sample JSONL files.

Codex tests should verify:

- discovery finds Codex files from `codexRoots`
- Codex provider parses first/last user text
- Codex provider parses last assistant text when available
- unknown event types are ignored safely
- message count is computed consistently
- project path / branch are filled when available
- search can find Codex conversation text
- provider filter works if implemented

## Implementation plan

1. Inspect the current files:
   - `src/scanner.ts`
   - `src/parser.ts`
   - `src/types.ts`
   - `src/discovery.ts`
   - `src/indexer.ts`
   - `src/git.ts`
   - existing tests and fixtures

2. Refactor current parser:
   - extract accumulator creation
   - extract `reduceEntry`
   - extract finalization
   - make current full parse call those functions

3. Add provider types:
   - provider name
   - discovery result
   - parse context
   - accumulator
   - provider registry

4. Wrap current parser/discovery as the default Threadbase provider.

5. Add Codex CLI provider:
   - candidate discovery from configured roots
   - defensive JSONL parsing
   - event normalization helpers
   - metadata extraction

6. Update scanner orchestration:
   - iterate enabled providers
   - merge results into one in-memory index
   - include provider in metadata
   - preserve current public API

7. Update session resolution:
   - exact path first
   - then non-unique sessionId deterministic lookup
   - add `getConversationsBySessionId` if appropriate

8. Update search indexing:
   - index provider metadata
   - keep old search tests passing
   - add Codex search tests

9. Add tests and fixtures.

10. Run:
   - typecheck
   - lint
   - test suite
   - package build

## Acceptance criteria

The implementation is complete when:

- existing Threadbase scanner tests pass
- new Codex CLI fixture tests pass
- scanner can scan Threadbase-only roots
- scanner can scan Codex-only roots
- scanner can scan both together
- `getConversation(filePath)` works for both providers
- `getConversation(sessionId)` remains compatibility-friendly but deterministic
- duplicate `sessionId` cases are handled without assuming uniqueness
- Codex unknown event shapes do not crash scanning
- no required native SQLite dependency is added to the main package
- parser logic is reducer-based and ready for future incremental indexing
```

Recommended sequencing: implement provider-aware scanning and Codex CLI support first. Do not implement SQLite and Codex support in the same pass. Once both Threadbase and Codex flow through the same normalized provider pipeline, persistent SQLite indexing becomes a cleaner follow-up task.
