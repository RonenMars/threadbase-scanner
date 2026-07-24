#!/usr/bin/env node
// Commit-analysis-only release precheck.
//
// WHY THIS EXISTS (and why it does NOT run `semantic-release --dry-run`):
// The release-precheck job only needs to answer "is a release warranted, and
// what's the next version?". The obvious way — `semantic-release --dry-run` —
// loads ALL configured plugins and runs their `verifyConditions` first, BEFORE
// commit analysis. `@semantic-release/npm`'s verifyConditions requires an npm
// auth token, so the dry-run aborts with "No npm token specified." before ever
// printing the next-version line. That coupled a read-only decision to npm
// publish credentials and caused every push to false-negative as "no
// release-worthy commits" whenever the token was missing/expired.
//
// Instead we call ONLY `@semantic-release/commit-analyzer` — the same plugin and
// the same rules the real release uses (loaded from .releaserc.json, so there's
// no rule duplication) — with no publishing plugins, no npm/OIDC auth, and no
// git remote access. The real publish is still handled solely by the `release`
// job (via OIDC Trusted Publishing).
//
// Scope: stable channel (vX.Y.Z) only. The `next` prerelease branch still gets a
// correct should_release, but its exact `-next.N` suffix is not computed here —
// the real release job computes the authoritative version regardless.

import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import semver from "semver";
import { createLogger } from "./lib/log.mjs";
import { isMainModule, repoRootFromScript } from "./lib/module.mjs";

const log = createLogger("release-precheck");
const defaultRepoRoot = repoRootFromScript(import.meta.url);

/** Run git and return trimmed stdout. */
export function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Extract the @semantic-release/commit-analyzer options from .releaserc.json. */
export function loadAnalyzerConfig(cwd = defaultRepoRoot) {
  const rc = JSON.parse(readFileSync(join(cwd, ".releaserc.json"), "utf8"));
  const entry = (rc.plugins || []).find(
    (p) =>
      p === "@semantic-release/commit-analyzer" ||
      (Array.isArray(p) && p[0] === "@semantic-release/commit-analyzer"),
  );
  if (!entry) {
    throw new Error(".releaserc.json has no @semantic-release/commit-analyzer plugin");
  }
  // entry is either the bare string or [name, options].
  return Array.isArray(entry) ? entry[1] || {} : {};
}

/**
 * Most recent stable release tag reachable from HEAD, as a vX.Y.Z string, or
 * null if there is no prior stable release. Prerelease tags (vX.Y.Z-next.N) are
 * intentionally excluded — this precheck targets the stable channel.
 */
export function lastStableTag(cwd = defaultRepoRoot) {
  const out = git(cwd, ["tag", "--list", "v*", "--merged", "HEAD", "--sort=-v:refname"]);
  if (!out) return null;
  for (const tag of out.split("\n")) {
    const version = tag.replace(/^v/, "");
    // semver.valid() rejects prerelease-suffixed tags only if we check for them
    // explicitly: it accepts 1.2.3-next.1. We want bare X.Y.Z.
    const parsed = semver.parse(version);
    if (parsed && parsed.prerelease.length === 0) return tag;
  }
  return null;
}

/** Commits since `tag` (or all history if tag is null), shaped for the analyzer. */
export function commitsSince(cwd = defaultRepoRoot, tag) {
  // %H <newline> %B (full message) <newline> NUL-terminator, so multi-line
  // bodies survive intact and commits split cleanly on the NUL.
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const raw = git(cwd, ["log", range, "--format=%H%n%B%x00"]);
  if (!raw) return [];
  return raw
    .split("\0")
    .map((chunk) => chunk.replace(/^\n/, ""))
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const nl = chunk.indexOf("\n");
      const hash = nl === -1 ? chunk : chunk.slice(0, nl);
      const message = nl === -1 ? "" : chunk.slice(nl + 1).trim();
      return { hash, message };
    });
}

/** Minimal logger matching the subset of signale the analyzer uses. */
const analyzerLogger = {
  log: () => {},
  error: (...args) => console.error(...args),
};

export function setOutput(key, value, outputPath = process.env.GITHUB_OUTPUT) {
  if (outputPath) {
    appendFileSync(outputPath, `${key}=${value}\n`);
  }
}

/**
 * @returns {{ shouldRelease: boolean, nextVersion: string, releaseType: string|null, tag: string|null, commitCount: number }}
 */
export async function runPrecheck(cwd = defaultRepoRoot, opts = {}) {
  const writeOutput = opts.setOutput ?? setOutput;
  log.step("init", `cwd=${cwd}`);

  log.step("load-analyzer-config");
  const pluginConfig = loadAnalyzerConfig(cwd);

  log.step("resolve-last-stable-tag");
  const tag = lastStableTag(cwd);
  log.step("resolve-last-stable-tag", `tag=${tag || "none"}`);
  const baseVersion = tag ? tag.replace(/^v/, "") : "0.0.0";

  log.step("list-commits", `since=${tag || "repo-start"}`);
  const commits = commitsSince(cwd, tag);
  log.step("list-commits", `count=${commits.length}`);

  log.step("analyze-commits");
  const releaseType = await analyzeCommits(pluginConfig, {
    commits,
    logger: analyzerLogger,
    cwd,
    env: process.env,
  });
  log.step("analyze-commits", `releaseType=${releaseType || "none"}`);

  if (!releaseType) {
    writeOutput("should_release", "false");
    writeOutput("next_version", "");
    log.info("No release-worthy commits — skipping build + publish.");
    log.step("done", "ok no-release");
    return {
      shouldRelease: false,
      nextVersion: "",
      releaseType: null,
      tag,
      commitCount: commits.length,
    };
  }

  log.step("compute-next-version", `base=${baseVersion} type=${releaseType}`);
  const nextVersion = semver.inc(baseVersion, releaseType);
  if (!nextVersion) {
    log.fail(
      "compute-next-version",
      `Could not compute next version from base "${baseVersion}" and release type "${releaseType}"`,
    );
    throw new Error(
      `Could not compute next version from base "${baseVersion}" and release type "${releaseType}"`,
    );
  }
  writeOutput("should_release", "true");
  writeOutput("next_version", nextVersion);
  log.info(
    `Would release v${nextVersion} (${releaseType} from ${commits.length} commits since ${tag || "repo start"})`,
  );
  log.step("done", `ok next=v${nextVersion}`);
  return {
    shouldRelease: true,
    nextVersion,
    releaseType,
    tag,
    commitCount: commits.length,
  };
}

async function main() {
  await runPrecheck(defaultRepoRoot);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    // Non-zero exit only on real errors — never for a legitimate "no release".
    log.fail("main", err.message);
    process.exit(1);
  });
}
