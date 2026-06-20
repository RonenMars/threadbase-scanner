import { readFileSync, writeFileSync } from "fs";
import { getLogger } from "../logger";
import type { ConversationMeta } from "../types";

export const SIDECAR_VERSION = 1;

// Portable, human-readable index summary written next to a JSONL file as
// `<file>.idx.json`. Not the canonical index (SQLite is) — useful for
// debugging, portability, and rebuilding the DB if it's lost. Off by default.
export interface Sidecar {
  version: number;
  sourcePath: string;
  sizeBytes: number;
  mtimeMs: number;
  lastIndexedOffset: number;
  lastIndexedLine: number;
  messageCount: number;
  projectPath: string;
  projectName: string;
  branch: string | null;
  firstSentAt: string | null;
  firstSentText: string | null;
  lastSentAt: string | null;
  lastSentText: string | null;
  updatedAt: string;
}

export function sidecarPath(jsonlPath: string): string {
  return `${jsonlPath}.idx.json`;
}

export function buildSidecar(
  meta: ConversationMeta,
  cursor: { sizeBytes: number; mtimeMs: number; offset: number; line: number },
  updatedAt: string,
): Sidecar {
  return {
    version: SIDECAR_VERSION,
    sourcePath: meta.filePath,
    sizeBytes: cursor.sizeBytes,
    mtimeMs: cursor.mtimeMs,
    lastIndexedOffset: cursor.offset,
    lastIndexedLine: cursor.line,
    messageCount: meta.messageCount,
    projectPath: meta.projectPath,
    projectName: meta.projectName,
    branch: meta.gitBranch,
    firstSentAt: meta.firstMessage?.timestamp ?? null,
    firstSentText: meta.firstMessage?.text ?? null,
    lastSentAt: meta.lastMessage?.timestamp ?? null,
    lastSentText: meta.lastMessage?.text ?? null,
    updatedAt,
  };
}

// Write the sidecar; never throw into the indexing path — a sidecar is a
// best-effort artifact, so a write failure (read-only dir, etc.) is logged and
// swallowed.
export function writeSidecar(jsonlPath: string, sidecar: Sidecar): void {
  try {
    writeFileSync(sidecarPath(jsonlPath), JSON.stringify(sidecar, null, 2));
  } catch (err) {
    getLogger().warn({ jsonlPath, err }, "sidecar: write failed");
  }
}

export function readSidecar(jsonlPath: string): Sidecar | null {
  try {
    return JSON.parse(readFileSync(sidecarPath(jsonlPath), "utf-8")) as Sidecar;
  } catch {
    return null;
  }
}
