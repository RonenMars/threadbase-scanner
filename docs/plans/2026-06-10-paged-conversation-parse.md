# Prompt: bounded paged conversation read (`getConversationPage`)

**Repo:** `tb-scanner` (`@threadbase/scanner`) · **Files:** `src/scanner.ts`, `src/parser.ts`, `src/types.ts`
**Companion prompts:** `tb-streamer/docs/plans/2026-06-10-conversation-etag-and-paged-tail.md`, `tb-mobile/docs/2026-06-10-conversation-etag-and-paged-cache.md`

> Paste this whole file to Claude Code in the `tb-scanner` repo. Read it fully before editing. Follow this repo's `CLAUDE.md` (conventional commits, tests in `__tests__/` with real JSONL fixtures in `__fixtures__/`, immutable filter functions, `npm run lint && npm test` before committing). This package is consumed by `tb-streamer` as a git submodule pinned by commit — a change here only reaches the streamer after the streamer bumps `vendor/scanner` and rebuilds. Note that in your commit message / PR.

## Why

`tb-streamer`'s `GET /api/conversations/{id}` serves one page of messages (last N, then scroll back). To do that it calls `scanner.getConversation(id)`, which `parseConversation()`-es the **entire** JSONL into a `Conversation` and the scanner caches the whole thing in an LRU. For a 10k-message conversation, serving any single page parses and holds all 10k messages. We want a bounded read that returns just the requested window plus the total count.

## What exists today (don't rebuild)

- `parseConversation(filePath, account)` in `src/parser.ts` — streams the file line-by-line and builds the full `messages[]`. No limit/offset.
- `ConversationScanner.getConversation(id)` in `src/scanner.ts` — resolves `id` (via `metadataCache` or `sessionIdIndex`), calls `parseConversation`, caches in `conversationLRU`.
- `ConversationScanner.refreshFile(filePath)` — re-parses meta + evicts the LRU (added recently).
- `GetConversationOptions` in `src/types.ts` — currently only `{ profiles? }`.

The streamer's `ConversationCache.populateTailFromFile` (in the **streamer** repo, not here) already demonstrates the bounded backward-chunk read pattern you'll mirror: read the file in fixed-size chunks from the end, split into lines, stop once you have enough. Use it as a reference for the tail case.

## The new method

Add to `ConversationScanner`:

```ts
async getConversationPage(
  id: string,
  options: { beforeIndex?: number; limit: number },
): Promise<{ messages: ConversationMessage[]; total: number; fromIndex: number } | null>
```

Semantics (must match how the streamer slices today so output is identical):
- `total` = total qualifying message count in the conversation.
- `beforeIndex` defaults to `total` (i.e. the newest page) when omitted.
- Returns the window `[max(0, beforeIndex - limit), beforeIndex)` in chronological order.
- `fromIndex` = the start index of the returned window (so the caller can build `from_index` / `has_more_older = fromIndex > 0`).
- Returns `null` if the file can't be resolved/parsed (same contract as `getConversation` returning null).

### Implementation guidance

The message **indexing must be identical** to a full `parseConversation` — the streamer currently indexes into `conversation.messages`, and the mobile client keys React list items on `message_index`. So "message N" here must be the same logical message as "message N" from the full parse. The safest correctness-preserving approach:

1. **Determine `total`** and the window boundaries. Because message identity depends on `parseConversation`'s own line→message reduction (it merges tool_use/tool_result, tracks thinking blocks, etc. — see `src/parser.ts`), you cannot naively map JSONL line numbers to message indices. Two acceptable strategies, pick the simpler one that passes the equivalence test:

   - **(Preferred, lowest-risk) Parse-once-then-slice with shared cache.** Parse the full conversation once, slice the window, and return `total` from the full set. This does NOT save the first parse, but it lets the scanner cache the parsed result and serve subsequent pages from cache. If you go this route, the win is purely "don't re-parse on every page" — make sure repeated `getConversationPage` calls for different windows of the same id reuse one parse (via the existing `conversationLRU` or a short-lived memo), and document that the bounded-memory win is deferred. This is a legitimate, shippable first step.

   - **(Optional, higher-effort) True bounded parse.** Stream the file once to compute `total` and record per-message byte offsets (or stream a second time skipping to the window), then parse only the window's lines through the same reduction logic `parseConversation` uses. Only attempt this if you can factor the line→message reduction in `parser.ts` into a reusable function so the windowed parse and the full parse share identical logic — otherwise message identity will drift and the equivalence test will fail. Do not duplicate the reduction logic.

2. Whichever strategy: **add an equivalence test** that proves `getConversationPage` returns exactly the same messages (same order, same content, same effective indices) as taking the corresponding slice of `parseConversation().messages`.

### Type changes

- Add the return type (inline or a named `ConversationPage` interface in `src/types.ts`).
- Do not change `getConversation`'s signature or behavior — `getConversationPage` is additive.

## Tests (`__tests__/scanner.test.ts`, fixtures in `__fixtures__/`)

Build a fixture with enough messages to exercise paging (e.g. 25–50 user/assistant lines):

- **Newest page** (`beforeIndex` omitted, `limit: 10`) returns the last 10 messages, `total` correct, `fromIndex = total - 10`.
- **Back-page** (`beforeIndex: fromIndex` from the previous call) returns the previous 10, `fromIndex` decremented.
- **First page** boundary: `beforeIndex <= limit` returns from index 0, `fromIndex = 0`.
- **Equivalence**: for several windows, `getConversationPage(id, {beforeIndex, limit})` equals `(await getConversation(id)).messages.slice(max(0, beforeIndex-limit), beforeIndex)`.
- **Unknown id** returns `null`.
- A fixture exercising tool_use/tool_result/thinking merging, to prove windowed indices match full-parse indices (guards against the message-identity drift risk).

## Out of scope

- Changing `parseConversation`'s public signature (other callers depend on it). If you need a windowed variant, add a new internal function or an options arg with a safe default.
- Search/index changes.
- The ETag validator — that's computed in the streamer from metadata; nothing to do here.

## Done when

- `npm run lint && npm test` green.
- `getConversationPage` exists, is exported via the `ConversationScanner` class (already re-exported from `src/index.ts`), and has an equivalence test against the full-parse slice.
- Commit message notes the streamer must bump `vendor/scanner` to pick this up (`chore: bump vendor/scanner (getConversationPage)` on the streamer side).
