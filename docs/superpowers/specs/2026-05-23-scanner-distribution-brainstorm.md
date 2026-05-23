# Brainstorm: scanner distribution strategy (in progress)

**Status:** Paused mid-brainstorm. Not a finished design — captures decisions made so far plus the open questions, so the next session can resume without re-doing the discovery.

**Date:** 2026-05-23
**Predecessor:** [bytenode-npm-package.md](../../plans/bytenode-npm-package.md) — failed bytenode attempt + lessons learned

## Where we ended up

Two sub-projects are now on the table. They are **independent** and were going to be brainstormed sequentially:

1. **Sub-project A — Scanner goes public + MIT** (this session was about to finish this)
2. **Sub-project B — Streamer as an npm-first package** (deferred to a separate brainstorm)

This document captures Sub-project A in detail (it's almost done) and Sub-project B's framing (so the next brainstorm starts in the right place).

---

## Sub-project A: scanner goes public + MIT

### Decisions settled in this session

1. **Threat model: casual copy-paste / drive-by inspection only.** Not competitors, not determined reverse-engineers. Implication: no bytecode, no obfuscation, no matrix complexity needed.

2. **The scanner's functionality is not novel.** A web search found at least 10+ open-source tools that parse `~/.claude/projects/` JSONL files (claude-history-explorer, claude-code-trace, claude-code-history-viewer, claude-code-chat-explorer, @kimuson/claude-code-viewer, withLinda/claude-JSONL-browser, ClaudeCodeJSONLParser, daaain/claude-code-log, jtklinger/claude-session-viewer, swyxio/claude-compaction-viewer, haasonsaas/claude-usage-tracker, and more). The scanner is commodity work; the differentiation is in the streamer's integration (PTY, WebSocket, mobile), not the scanner itself.

3. **Going fully MIT open-source.** Scanner repo becomes public. No protection layer. The npm/git-URL question is the only remaining axis.

### Decisions still open (3 small ones)

These are the only questions left before the design is complete:

#### D1. Consumption mechanism — npm publish OR git URL dep?

How does `tb-streamer/package.json` reference the scanner?

| Option | What it looks like | Best fit |
|---|---|---|
| **npm publish** | `"@ronenmars/threadbase-scanner": "^0.3.0"` | Cleanest, but adds a release pipeline to maintain |
| **Git URL dep** | `"@threadbase/scanner": "github:RonenMars/threadbase-scanner#v0.3.0"` | Skip npm entirely; npm clones + builds the public repo on install. Trivially reversible to npm later. |

**Recommendation:** Start with git URL dep. Promote to npm publish later if interest grows.

**Why:** You haven't decided whether scanner is a "real" community library or "the parser the streamer needs." Git URL lets you defer that. The cost (5-15s slower `npm install` for streamer developers, paid only by them, not end users) is small. Trivially reversible: one line in streamer's `package.json`.

This question was held open when the conversation pivoted to streamer-on-npm. Worth re-considering once Sub-project B is brainstormed: if streamer-on-npm requires scanner-as-npm-dep for some reason, that constrains the answer here.

#### D2. Package name (only matters if D1 picks npm publish)

| Option | Status |
|---|---|
| `@ronenmars/threadbase-scanner` | Available, already verified, you're authenticated |
| Unscoped name (`claude-conversation-scanner`, `tb-conversation-scanner`, etc.) | Need to check availability for specific name |

**Recommendation:** `@ronenmars/threadbase-scanner` — path of least resistance, name already secured. Can rename later if community uptake demands it.

**Constraint discovered:** Unscoped `threadbase` is taken by another publisher (`aniketrode` — see [npm](https://www.npmjs.com/package/threadbase)). Anything with `threadbase` as the literal package name is out. Scoped under `@ronenmars/` is fine.

#### D3. Cleanup of existing bytenode artifacts

Currently in `tb-scanner` main branch:
- Commit `1fef563`: original bytenode + rename to @ronenmars/threadbase-scanner
- Commit `51157cb`: tarball validator fix + version 0.2.1
- Commit `192ddd6`: drop prepublishOnly and --provenance, version 0.2.2 (unpublished from npm)
- Untracked: `src/loader/`, `scripts/build-bytenode.mjs`, `scripts/assemble-dist.mjs`, `.github/workflows/release.yml`, plan file in `docs/plans/`

Tags `v0.2.0` and `v0.2.2` exist on GitHub pointing at failed-build commits.

**Two options:**

1. **Revert bytenode commits, restore pre-bytenode state.** `git revert` the three commits, leaving a clean main branch matching what the scanner looked like before bytenode was attempted. Failed tags stay (history is honest).
2. **Leave commits in place, just delete unused files.** Main branch keeps the bytenode commits but the bytenode infrastructure (`src/loader/`, `scripts/build-bytenode.mjs`, etc.) gets removed in a new commit titled something like `chore: remove bytenode pipeline (cross-platform .jsc not viable)`. Plan file in `docs/plans/` stays as historical record.

**Recommendation:** Option 2. The bytenode commits are useful history — they show what was tried and why it didn't work. A clean removal commit on top is more honest than rewriting history.

### What the scanner design looks like

Once D1–D3 are answered, the design is:

**Architecture:**
- `tb-scanner` becomes a public MIT-licensed GitHub repo
- No protection layer (plain JS, optionally minified via terser if we want a tiny speed bump against accidental copy-paste — separate decision)
- Existing tsup build produces `dist/index.js` (ESM) + `dist/index.cjs` (CJS) + `dist/cli.js` (CLI) + `.d.ts`
- Distribution: per D1's answer (npm or git URL)
- Streamer's `vendor/scanner` submodule is removed; streamer references scanner via the chosen channel

**Components affected:**
- `tb-scanner/`: repo visibility flip, LICENSE add, bytenode cleanup commit, possibly minor README rewrite
- `tb-streamer/package.json`: dep line change
- `tb-streamer/.gitmodules`: remove `vendor/scanner` block (keep `vendor/menubar`)
- `tb-streamer/vendor/scanner/`: directory removed via `git rm` + `git submodule deinit`
- `tb-streamer/scripts/deploy.sh`: remove `ensure_scanner_built` function and `--update-scanner` plumbing
- `tb-streamer/scripts/deploy.ps1`, `deploy-linux.sh`: matching changes
- `tb-streamer/CLAUDE.md`: documentation refresh

**Execution effort:** ~1.5–2 hours of mechanical work after the spec is written.

### What's NOT included in Sub-project A

- Streamer's install model is unchanged. Deploy scripts continue to be the primary install path.
- Scanner is consumed by streamer in whatever way D1 settles. Streamer's build/deploy pipeline adapts to that, no other changes.

---

## Sub-project B: streamer as an npm-first package (deferred)

This was raised mid-session and confirmed as **Vision 1**: npm install is the only install path, then a `threadbase-streamer setup` subcommand registers the OS service.

### Why it was deferred to a separate brainstorm

The scope is genuinely larger than scanner-goes-public. Estimated 15–20 more clarifying questions to surface design decisions. Combining it into this session would either produce a shallower spec or extend this session by hours. The brainstorming skill is explicit about flagging multi-subsystem requests for decomposition.

### Open questions that the next brainstorm needs to handle

(Captured here so the next session can hit the ground running.)

1. **How does `npm install -g threadbase-streamer` interact with the existing `~/.threadbase/releases/<sha>/` symlink scheme?** Does it survive? Does the npm-global-bin path replace it? Does `current/` symlink still mean anything?

2. **Native modules in the global install path.** `node-pty` and `better-sqlite3` need C++ compilation or prebuilt binaries. What's the prebuild coverage on each target platform (macOS Intel, macOS ARM64, Linux x64, Linux ARM64, Windows x64)? What happens when prebuild is missing — does `npm install -g` fail gracefully? Do we instruct users to install build tools, or is that a non-starter for non-developers?

3. **The `setup` subcommand's responsibility surface.** What does it do?
   - Register launchd plist (macOS) / systemd-user unit (Linux) / Task Scheduler task (Windows)
   - Create `~/.threadbase/` config directory
   - Generate API key, write `server.yaml`
   - Default `update.yaml`
   - Cloudflare Tunnel setup (optional — interactive prompt?)
   - All of these need cross-platform Node implementations

4. **Auto-updater coexistence.** The current updater has smart logic: active-session defer, HMAC webhook trigger, version pinning via `update.yaml`, service-label resolution. With npm-first:
   - Does `npm update -g threadbase-streamer` bypass the active-session defer? (Risk: kills a user's running session.)
   - Does the existing updater become a wrapper around `npm update`?
   - Is the webhook path (`POST /api/__update`) still meaningful?
   - What's the user-facing update command? `threadbase-streamer update` (wrapping npm) or just `npm update -g`?

5. **Migration story for existing users.** Someone who installed via `deploy.sh` 6 months ago has:
   - `~/.threadbase/releases/<old-sha>/` directory
   - A launchd plist pointing at `~/.threadbase/current/cli.cjs`
   - A `~/.threadbase/server.yaml` with their API key
   - Possibly a Cloudflare Tunnel pointing at port 8766
   
   How do they migrate to the npm-installed version without:
   - Losing their API key (mobile clients would all need re-pairing)
   - Breaking the menubar (which reads `port:` from `server.yaml`)
   - Breaking active mobile sessions
   - Breaking the Cloudflare Tunnel mapping

6. **Menubar coupling.** Menubar reads `~/.threadbase/server.yaml` for port, polls `localhost:<port>/healthz`. With npm-install, does the streamer still write `server.yaml`? Is the port discoverable some other way? Does the menubar app need to change?

7. **Windows-specific gotchas (from CLAUDE.md).** Task Scheduler env var inheritance issues, stale port 8766, submodule SSH→HTTPS, Path separators. All of these need to be handled in the cross-platform `setup` subcommand.

8. **Cross-platform service registration in JS.** Today this lives in 3 shell scripts (one per OS). Moving it to a Node `setup` subcommand means one JS implementation that does the right thing on all three. Libraries like `node-windows`, `node-mac`, `node-linux` exist but vary in quality. Or we shell out to `launchctl`, `systemctl --user`, `schtasks.exe` from the JS code.

9. **The `~/.threadbase/server.yaml` lifecycle.** Generated by deploy script today. With npm-first: generated by `setup`? Read by streamer at boot? What's the precedence between env vars, server.yaml, and CLI flags?

10. **What about the `update.yaml`** — does it survive? What about webhook URLs, allowed update channels, etc.?

### What it definitely is NOT

- Not a rewrite of the streamer's runtime logic (PTY manager, WebSocket hub, REST API). All of that stays the same.
- Not changing the mobile client's view of the world. Mobile still hits `/healthz` and `/api/...` over HTTP/WS.
- Not coupled to whether scanner is on npm. Sub-project B works fine whether scanner is consumed via npm, git URL, or submodule.

### Estimated effort

- Brainstorm: 1–2 hours of clarifying questions before a design takes shape, then design + spec write
- Implementation: ~1–2 weeks of work, much of it on edge-case handling across the three platforms

---

## Cross-cutting notes from this session

### What was already discovered (in earlier session that's now in MEMORY)

- Bytenode `.jsc` is NOT cross-platform despite README's "CPU-agnostic" claim ([bytenode#244](https://github.com/bytenode/bytenode/issues/244)). Maintainer confirms it will never be unless V8 changes.
- `npm publish --provenance` rejects publishes from private GitHub repos.
- `prepublishOnly` running `npm run build` in CI breaks the matrix-assembled `dist/`.
- npm `@threadbase` org creation was denied (likely due to existing unscoped `threadbase` package).
- `@ronenmars/threadbase-scanner@0.2.2` was unpublished from npm; version number `0.2.2` is permanently tombstoned.

### Decisions log for this brainstorm session

| # | Decision | Result |
|---|---|---|
| 1 | Threat model | Casual copy-paste / drive-by inspection only |
| 2 | Protection level needed | None (going fully MIT open-source) |
| 3 | tb-scanner repo visibility | Will become public (timing TBD) |
| 4 | License | MIT |
| 5 | Streamer install model | Vision 1: npm install + `tb-streamer setup` subcommand (deferred to Sub-project B) |
| 6 | Project decomposition | Sub-project A and Sub-project B will be brainstormed separately |
| 7 | Today's brainstorm scope | Sub-project A only (scanner goes public + MIT) |
| 8 | D1 / D2 / D3 | Open — to be resolved when scanner brainstorm resumes |

### Where to pick up

**To finish Sub-project A** (scanner goes public): resume from D1 (npm publish vs git URL dep). After D1–D3, the design is complete; write the spec to `docs/superpowers/specs/2026-05-23-scanner-goes-public-design.md`, run the spec self-review, ask user to review, then invoke `writing-plans` skill.

**To start Sub-project B** (streamer as npm-first package): begin a fresh brainstorm session. Use the 10 open questions above as the agenda. Probably start with question 5 (migration story) since it constrains a lot of the other answers.

### Tasks created during this brainstorm

Carried forward in the harness's task list:

- #10 Explore project context (completed)
- #11 Ask clarifying questions, one at a time (completed)
- #12 Propose 2-3 approaches with tradeoffs (in progress — paused)
- #13 Present design in scaled sections (pending)
- #14 Write design doc to docs/superpowers/specs/ (pending)
- #15 Spec self-review + user review gate (pending)
- #16 Invoke writing-plans skill (pending)

These can be marked completed for the original brainstorming flow (since we exported the state instead of finishing) — or left in place if you want to resume the same task chain when picking back up.
