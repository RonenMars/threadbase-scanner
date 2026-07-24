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
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import semver from "semver";

const defaultRepoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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
const logger = {
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
  const pluginConfig = loadAnalyzerConfig(cwd);
  const tag = lastStableTag(cwd);
  const baseVersion = tag ? tag.replace(/^v/, "") : "0.0.0";
  const commits = commitsSince(cwd, tag);

  const releaseType = await analyzeCommits(pluginConfig, {
    commits,
    logger,
    cwd,
    env: process.env,
  });

  if (!releaseType) {
    writeOutput("should_release", "false");
    writeOutput("next_version", "");
    console.log("ℹ️  No release-worthy commits — skipping build + publish.");
    return {
      shouldRelease: false,
      nextVersion: "",
      releaseType: null,
      tag,
      commitCount: commits.length,
    };
  }

  const nextVersion = semver.inc(baseVersion, releaseType);
  if (!nextVersion) {
    throw new Error(
      `Could not compute next version from base "${baseVersion}" and release type "${releaseType}"`,
    );
  }
  writeOutput("should_release", "true");
  writeOutput("next_version", nextVersion);
  console.log(
    `✅ Would release v${nextVersion} (${releaseType} from ${commits.length} commits since ${tag || "repo start"})`,
  );
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

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && fileURLToPath(import.meta.url) === entry) {
  main().catch((err) => {
    // Non-zero exit only on real errors — never for a legitimate "no release".
    console.error("release-precheck failed:", err.message);
    process.exit(1);
  });
}
