# Design: tb-scanner goes public + MIT, consumed via git URL

**Date:** 2026-05-24
**Status:** Approved by user; ready for implementation planning
**Predecessors:**
- [bytenode-npm-package.md](../../plans/bytenode-npm-package.md) — failed bytenode attempt + lessons learned
- [2026-05-23-scanner-distribution-brainstorm.md](2026-05-23-scanner-distribution-brainstorm.md) — brainstorm session that produced this design

## Context

The project owner is moving `tb-streamer` toward an open-source distribution model. The first step is releasing `tb-scanner` (currently a private git submodule consumed by streamer at `vendor/scanner`) under MIT on a public GitHub repo, with the streamer consuming it via npm's native git-URL dependency mechanism.

A prior attempt (bytenode-based bytecode protection) was abandoned after discovering that bytenode `.jsc` files are not cross-platform despite the README's claim. See the predecessor docs for the full discovery loop.

This design adopts the **opposite** stance from that attempt: no protection layer at all. The brainstorm session established that:

1. The threat model is casual copy-paste / drive-by inspection only — not competitors, not determined reverse-engineers.
2. The scanner's functionality is not novel — at least 10+ open-source tools already parse `~/.claude/projects/` JSONL files (claude-history-explorer, claude-code-trace, @kimuson/claude-code-viewer, withLinda/claude-JSONL-browser, ClaudeCodeJSONLParser, daaain/claude-code-log, etc.). The differentiation is in the streamer's *integration* (PTY, WebSocket, mobile), not the scanner library.
3. The cost of any protection layer (bytecode, obfuscation, native binary) is high relative to the marginal protection it provides for casual-tier threats. Going fully open-source eliminates that cost entirely.

The result is a small, mechanical change with a small risk surface. This design captures it precisely so implementation can be planned and executed without further discovery.

## Goal

After this change:

- `RonenMars/threadbase-scanner` is a **public MIT-licensed GitHub repo**, source available, contributable.
- `tb-streamer` consumes scanner via **npm's git URL dependency** (`github:RonenMars/threadbase-scanner#v0.3.0`) instead of the current `file:./vendor/scanner` submodule reference.
- The `vendor/scanner` submodule is removed from `tb-streamer`. The deploy scripts no longer build scanner — npm handles it during `npm install`.
- The bytenode pipeline artifacts in `tb-scanner` are deleted; the build returns to its pre-bytenode shape (plain tsup, dual ESM/CJS, no per-Node-version dispatch).

## Non-goals

Explicitly out of scope:

- **Publishing scanner to npm.** Deferred. We use git URL deps instead. Reversible to npm later with a one-line change in streamer's `package.json` — does not require any change in scanner.
- **Streamer's install model.** Not touched. Deploy scripts continue to be the production install path. (Sub-project B — streamer-as-npm-package — is deferred to a separate brainstorm; see [2026-05-23-scanner-distribution-brainstorm.md](2026-05-23-scanner-distribution-brainstorm.md).)
- **Migrating the production deployment.** No migration step needed. The running streamer's `cli.cjs` has scanner already bundled into it; how that bundle was produced is invisible at runtime.
- **Cleanup of `@ronenmars/threadbase-scanner@0.2.2` tombstone on npm.** Leave it. The tombstone is permanent; the next time we publish (if ever) we'd use a different version number anyway.
- **Any change to the `vendor/menubar` submodule.** Stays as it is.

## Architecture

End state, both repos:

```
RonenMars/threadbase-scanner (PUBLIC GitHub repo, MIT)
├── src/                  TypeScript source (unchanged)
├── cli/                  CLI source (unchanged)
├── package.json          reverted: no bytenode dep, engines >= 18, bin → dist/cli.js
├── tsup.config.ts        reverted: CLI emits ESM with shebang
├── LICENSE               new: MIT
├── README.md             updated: bytenode-specific sections removed
├── CLAUDE.md             updated: bytenode-specific architecture removed
├── .github/workflows/
│   ├── ci.yml            test matrix back to [18, 20, 22]; lint/build on 20
│   └── release.yml       DELETED
└── docs/plans/bytenode-npm-package.md   kept as historical record

RonenMars/tb-streamer (still private)
├── package.json          dep: "@threadbase/scanner": "github:RonenMars/threadbase-scanner#v0.3.0"
├── .gitmodules           vendor/scanner block removed; vendor/menubar stays
├── vendor/scanner/       DELETED
├── scripts/
│   ├── deploy.sh         ensure_scanner_built() removed; --update-scanner flag removed
│   ├── deploy.ps1        same removals (Windows)
│   └── deploy-linux.sh   same removals (Linux)
└── CLAUDE.md             dependencies + build-notes sections refreshed
```

## Data flow at install time

When a developer runs `npm install` in `tb-streamer`:

1. npm reads `package.json` and sees `"@threadbase/scanner": "github:RonenMars/threadbase-scanner#v0.3.0"`
2. npm clones the public scanner repo at tag `v0.3.0`
3. npm runs `npm install` inside scanner's clone (installs devDependencies — tsup, biome, vitest, etc.)
4. npm runs scanner's `prepare` script (new: `"prepare": "npm run build"`) — which runs `tsup`, producing `dist/`
5. The result lands in `node_modules/@threadbase/scanner/dist/`, indistinguishable from an npm-published install
6. Streamer's own `npm run build` then runs as before; tsup bundles scanner into `dist/cli.cjs`

This is npm's standard git-URL dependency flow. No custom infrastructure required. The first install is slow (~5-15 seconds for the scanner clone+build), but cached after that.

## Components and change list

### `tb-scanner` — single forward-cleanup commit

Commit message: `chore: remove bytenode pipeline, restore plain JS build`

| File | Change |
|---|---|
| `package.json` | Remove `bytenode` from `dependencies`. Revert `engines.node` from `>=22` back to `>=18`. Restore `bin.threadbase-scanner` to `dist/cli.js` (not `cli.cjs`). Restore `build` script to just `tsup`. Remove `build:tsup` and `build:bytenode` scripts. **Add `"prepare": "npm run build"` script** — required for git URL dep consumers; npm runs this automatically after cloning so `dist/` exists in `node_modules/@threadbase/scanner/` even though `dist/` is gitignored. Bump version to `0.3.0`. |
| `tsup.config.ts` | Revert to the pre-bytenode shape: CLI emits ESM (`format: ["esm"]`) with shebang banner. `sourcemap: true` restored on both entries. |
| `src/loader/` | Delete entire directory (`index.cjs`, `index.js`, `cli.cjs`). |
| `scripts/build-bytenode.mjs` | Delete. |
| `scripts/assemble-dist.mjs` | Delete. |
| `.github/workflows/release.yml` | Delete. |
| `.github/workflows/ci.yml` | Restore test matrix from `[22, 23, 24, 25, 26]` back to `[18, 20, 22]`. Restore lint/build `node-version` from 22 back to 20. |
| `package-lock.json` | Refresh via `npm install` after package.json edit. |
| `README.md` | Remove the "Supported Node versions" section that explained bytenode bytecode and supported-major dispatch. Other sections unchanged. |
| `CLAUDE.md` | Remove the bytenode-specific subsections under "Architecture" (the "Build pipeline — two stages" and "Supported Node versions" subsections). Restore the original Architecture text. Restore "Commands" section to match the simpler `build` script. |
| `docs/plans/bytenode-npm-package.md` | **Keep** unchanged. |
| `docs/superpowers/specs/2026-05-23-scanner-distribution-brainstorm.md` | **Keep** unchanged. |
| `docs/superpowers/specs/2026-05-24-scanner-goes-public-design.md` | This file — written before the cleanup commit and included in it. |

### `tb-scanner` — repo-level actions (not part of the cleanup commit)

Performed via the GitHub web UI or `gh` CLI:

1. **Pre-flip safety check** — `git log --all --pretty=format:"%H %s" | head -100` and a `git grep` for `secret|password|token|key` across history. Spot-check for accidentally-committed secrets before going public.
2. **Add LICENSE file** — small dedicated commit titled `chore: add MIT LICENSE`. Standard MIT text with the current year and "Ronen Mars" as the copyright holder.
3. **Flip repo visibility** to public via GitHub repo Settings → Danger zone → Change visibility.
4. **Tag `v0.3.0`** after the cleanup commit and the LICENSE commit are both on `main`. Push the tag.

The failed tags `v0.2.0` and `v0.2.2` on GitHub are left in place — they're honest history showing what was attempted.

### `tb-streamer` — single commit

Commit message: `feat: consume @threadbase/scanner from public GitHub instead of submodule`

| File | Change |
|---|---|
| `package.json` | Replace `"@threadbase/scanner": "file:./vendor/scanner"` with `"@threadbase/scanner": "github:RonenMars/threadbase-scanner#v0.3.0"`. |
| `package-lock.json` | Refresh via `npm install` after package.json edit. |
| `.gitmodules` | Remove the `[submodule "vendor/scanner"]` block. Keep `[submodule "vendor/menubar"]`. |
| `vendor/scanner/` | Delete via `git rm -r vendor/scanner` + `git submodule deinit vendor/scanner`. |
| `scripts/deploy.sh` | Remove `SCANNER_DIR="$REPO_ROOT/vendor/scanner"` (around line 37). Remove the `ensure_scanner_built()` function entirely (lines 224-260). Remove the `--update-scanner` CLI flag plumbing (lines 650, 654, 681). Remove the `ensure_scanner_built "$update_scanner"` call. Update the usage-string at line 778 to drop `--update-scanner`. |
| `scripts/deploy.ps1` | Mirror the same removals on the Windows side. |
| `scripts/deploy-linux.sh` | Mirror the same removals on the Linux side. |
| `CLAUDE.md` | In the "Dependencies" section: change `@threadbase/scanner`'s description from "git submodule pointing at `vendor/scanner`" to "consumed from public GitHub repo via npm git URL dep (`github:RonenMars/threadbase-scanner#<tag>`)". In the npm `run` scripts list near the top: remove `deploy:update-scanner`. |

### What does NOT change in `tb-streamer`

- `src/server.ts`, `src/services/projectChats/listProjectChats.ts`, and every other consumer of scanner — they keep their `import { ConversationScanner, ... } from "@threadbase/scanner"` statements. The bare specifier resolves identically whether scanner was a submodule or a git URL dep.
- `tsup.config.ts` — scanner stays bundled into `cli.cjs` via the existing `noExternal: [/^(?!node-pty|better-sqlite3).*/]` regex. Bundle output shape is unchanged.
- The deploy script's `node_modules` copy loop (`for mod in node-pty better-sqlite3 bindings file-uri-to-path`) — scanner is bundled, not external, so it doesn't appear here.
- The auto-updater (`src/updater/`) — unchanged. The release tarball it downloads is unchanged in shape.
- `vendor/menubar` — stays as a submodule.

## Order of operations

Performed in this exact order to keep the dependency direction safe (scanner must be tagged before streamer references the tag):

1. **Scanner: pre-flip safety check.** Run history grep for secrets, review log briefly. Abort if anything sensitive is found.
2. **Scanner: write the cleanup commit.** All file edits listed in the table above. Run `npm install` (refreshes lockfile) and `npm run lint` + `npm test` before committing to confirm the pre-bytenode build still works.
3. **Scanner: add LICENSE commit.** Small separate commit, MIT text, current year.
4. **Scanner: flip repo to public** via GitHub settings.
5. **Scanner: tag `v0.3.0`** and push tag + main.
6. **Streamer: write the consumption-switch commit.** `package.json` edit, submodule removal, deploy script cleanup. Run `npm install` (clones scanner from GitHub during install) + `npm run lint` + `npm test` + `npm run build` before committing.
7. **Streamer: deploy locally** via `npm run deploy` and verify `curl http://localhost:8766/healthz` returns `{ok, version}`. Confirm a mobile client still connects, lists conversations, can resume a session.
8. **Streamer: commit.** Once verified.

Steps 1-5 are scanner-only. Steps 6-8 are streamer-only. The two repos are loosely coupled — neither commit needs the other beyond the dependency direction (streamer references a specific scanner tag).

## Verification

Three checks, in order:

### Check 1: scanner builds from a fresh clone on multiple Node versions

Simulates outside-contributor experience. From a directory that is *not* `tb-scanner`:

```bash
cd /tmp && rm -rf scanner-clone-test && mkdir scanner-clone-test && cd scanner-clone-test
npm init -y
npm install github:RonenMars/threadbase-scanner#v0.3.0
node -e "console.log(Object.keys(require('@threadbase/scanner')).sort().join(', '))"
```

Expected: npm clones scanner, runs `prepare`, lands in `node_modules/@threadbase/scanner/dist/`, the `require()` returns 25+ named exports including `ConversationScanner`, `applyPagination`, `search`, etc. Repeat on Node 18, 20, 22 to match scanner's `engines.node` range.

### Check 2: streamer builds end-to-end against the GitHub-installed scanner

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
rm -rf node_modules dist
npm install
npm run lint
npm run build
npm test
```

Expected: every step succeeds. The first `npm install` is slower than usual because it clones scanner from GitHub — that's the expected one-time cost.

### Check 3: streamer deploys and the deployed binary actually runs

```bash
cd /Users/ronenmars/Desktop/dev/ai-tools/tb-streamer
npm run deploy
sleep 2
curl http://localhost:8766/healthz
```

Expected: deploy completes, `/healthz` returns `{ok, version}`. Mobile client (paired before the change) connects, lists conversations, resumes a session. Scanner functions (`/api/conversations`, agent-filter, search) behave identically to pre-change.

If all three pass, the migration is complete.

## Risks and mitigations

The change is small, so the risk surface is small. Risks worth surfacing:

**R1 — Outside contributor on a restricted network can't clone github.com.**
Worst case is a corporate firewall blocks GitHub HTTPS. Out of scope to solve; they have bigger problems.

**R2 — Scanner's `prepare` script fails on a contributor's Node version.**
Scanner's `engines.node` is `>=18`. Anyone on Node < 18 gets a friendly error. Streamer also requires `>=18`, so this is already the contract.

**R3 — A future security audit finds the secret-check missed something.**
Pre-flip secret scan covers known categories (`secret|password|token|key`) but isn't exhaustive. Mitigation: also use `gh secret-scanning` if it's enabled on the repo, and rely on GitHub's automated secret scanning for public repos as a backstop.

**R4 — GitHub Actions on the now-public scanner repo run on PRs from forks and consume CI minutes.**
GitHub gives generous free minutes for public repos. The remaining `ci.yml` runs lint + tests only — no secrets, no deploy. Safe to run on PRs from forks. The release workflow (which had `NPM_TOKEN` access) is being deleted.

**R5 — npm caching weirdness when streamer's CI fetches scanner from GitHub.**
`npm install` of a git-URL dep uses git, not the npm cache, so cache pollution is unlikely. CI may be slower on cold runs. If this becomes annoying, we add `actions/cache` keyed on scanner's git ref.

**R6 — Adding `prepare` script causes redundant build in scanner's own CI.**
Scanner's CI build job already runs `npm install` (now triggers `prepare → npm run build`) followed by an explicit `npm run build`. The second build is redundant, ~few seconds wasted. Not a blocker. Can be optimized later by collapsing the steps.

**R6 — A contributor tries to `npm publish` scanner from their machine.**
Scanner's `package.json` has no `publishConfig` or auth-gated publish workflow after the cleanup. A contributor could theoretically run `npm publish` and accidentally publish under `@ronenmars/threadbase-scanner` if they're authenticated as `ronenmars` — but they wouldn't be. Safe by default.

## Rollback

If verification fails after any commit:

**Scanner side:**
- Public-flip is reversible: GitHub Settings → make private.
- Forward cleanup commit is reversible: `git revert <sha>` restores the bytenode pipeline files (but they don't work — useful only to roll back the deletion mechanics, not to restore functionality).
- Tag `v0.3.0` can be deleted from GitHub if it points at a broken commit, same recipe as the v0.2.x cleanup in the lessons-learned doc.

**Streamer side:**
- Submodule removal is reversible: `git revert <sha>` restores `.gitmodules`, then `git submodule update --init vendor/scanner` clones the submodule back at its previous pin.
- Deploy script changes come back in the same revert.

The two repos are loosely coupled. Scanner can succeed while streamer fails verification, or vice versa, and either side can be rolled back independently.

## Open questions deferred to other designs

These are explicitly not handled here:

1. **Should scanner ever publish to npm?** Decision deferred. Trivially reversible from this state (one-line change in streamer's `package.json`).
2. **Should streamer install model become npm-first?** Deferred to Sub-project B (a separate brainstorm).
3. **Minify scanner's published JS?** Not done here — would add a tiny speed bump against accidental copy-paste with no downside. Worth a separate small decision later.

## Glossary

- **Git URL dep**: npm's native ability to declare a dependency as `"name": "github:owner/repo#ref"`, where `ref` is a tag, branch, or SHA. npm clones the repo, runs its `prepare` script, and treats the resulting `dist/` as if it were an npm-published package.
- **Bundled into `cli.cjs`**: streamer's tsup config produces a single bundled `dist/cli.cjs` that includes scanner's compiled source inline (because of `noExternal: [/^(?!node-pty|better-sqlite3).*/]`). At runtime, the deployed streamer doesn't load scanner from `node_modules/`; it loads it from inside its own bundle.
- **Submodule**: git's mechanism for nesting one repo inside another at a specific commit pin. `tb-streamer` currently has `vendor/scanner` as a submodule pointing at `RonenMars/threadbase-scanner`. After this change, `vendor/scanner` is gone and the relationship is purely declared in `package.json`.
