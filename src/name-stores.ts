import Database from "better-sqlite3";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import { getLogger } from "./logger";
import type { ScannerProviderName } from "./providers/provider";
import { applyNameCandidate, type NameSlot, type NameSlots } from "./session-name";

// Name sources that live beside a transcript instead of inside it. Every reader
// returns the slots it found for one session id and never throws: a missing,
// locked or corrupt store yields {} so the transcript's own slots still resolve.

function slotsFrom(
  provider: ScannerProviderName,
  candidates: Array<[NameSlot, unknown]>,
): NameSlots {
  return candidates.reduce<NameSlots>(
    (slots, [slot, raw]) =>
      applyNameCandidate(slots, slot, typeof raw === "string" ? raw : undefined, provider),
    {},
  );
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// Read-only, existing files only: never creates, locks for writing, or waits
// long on a database another process (Cursor's 3.9 GB state.vscdb) keeps open.
function queryOne<T>(dbPath: string, sql: string, ...params: unknown[]): T | undefined {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
    return db.prepare(sql).get(...params) as T | undefined;
  } catch (err) {
    getLogger().debug({ dbPath, err }, "name store: query failed");
    return undefined;
  } finally {
    db?.close();
  }
}

// id → value from the LAST line carrying that id, cached until the file changes
// (a Codex index/history can be large and is read once per session otherwise).
const lastByIdCache = new Map<string, { sig: string; map: Map<string, string> }>();

function lastValueById(path: string, idField: string, valueField: string): Map<string, string> {
  let sig: string;
  try {
    const s = statSync(path);
    sig = `${s.mtimeMs}:${s.size}`;
  } catch {
    return new Map();
  }
  const key = `${path}\0${idField}\0${valueField}`;
  const cached = lastByIdCache.get(key);
  if (cached?.sig === sig) return cached.map;

  const map = new Map<string, string>();
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const id = row[idField];
        const value = row[valueField];
        if (typeof id === "string" && typeof value === "string") map.set(id, value);
      } catch {}
    }
  } catch {}
  lastByIdCache.set(key, { sig, map });
  return map;
}

// ── Codex ────────────────────────────────────────────────────────────────────

// `codexHome` is the directory holding session_index.jsonl, history.jsonl and
// state_5.sqlite (normally ~/.codex).
export function readCodexNameSlots(codexHome: string, id: string): NameSlots {
  const index = lastValueById(join(codexHome, "session_index.jsonl"), "id", "thread_name");
  const history = lastValueById(join(codexHome, "history.jsonl"), "session_id", "text");

  let title = index.get(id);
  // The sqlite title is only consulted when the index has no line for the id.
  if (!index.has(id)) {
    title = queryOne<{ name: string | null }>(
      join(codexHome, "state_5.sqlite"),
      "SELECT name FROM threads WHERE id = ?",
      id,
    )?.name as string | undefined;
  }
  return slotsFrom("codex-cli", [
    ["toolTitle", title],
    ["lastPrompt", history.get(id)],
  ]);
}

// ── Cursor ───────────────────────────────────────────────────────────────────

// `chatsDir` is ~/.cursor/chats; a chat is <chatsDir>/<workspace hash>/<id>/.
export function readCursorCliNameSlots(chatsDir: string, id: string): NameSlots {
  let chat: string | undefined;
  try {
    chat = readdirSync(chatsDir)
      .map((hash) => join(chatsDir, hash, id))
      .find((p) => existsSync(p));
  } catch {}
  if (!chat) return {};

  const meta = readJson(join(chat, "meta.json")) as { title?: unknown } | undefined;
  const history = readJson(join(chat, "prompt_history.json"));
  let title = meta?.title;
  if (typeof title !== "string" || !title.trim()) title = storeDbName(join(chat, "store.db"));

  // prompt_history.json is newest-first.
  return slotsFrom("cursor", [
    ["toolTitle", title],
    ["lastPrompt", Array.isArray(history) ? history[0] : undefined],
  ]);
}

// store.db keeps the chat's metadata as hex-encoded JSON under meta key "0".
function storeDbName(dbPath: string): string | undefined {
  const row = queryOne<{ value: string | Buffer }>(
    dbPath,
    "SELECT value FROM meta WHERE key = '0'",
  );
  if (!row) return undefined;
  try {
    const text = row.value.toString();
    const json = /^(?:[0-9a-f]{2})+$/i.test(text)
      ? Buffer.from(text, "hex").toString("utf8")
      : text;
    const name = (JSON.parse(json) as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

// One primary-key lookup, never a table scan: state.vscdb is multi-GB and Cursor
// has it open.
export function readCursorIdeNameSlots(stateDbPath: string, id: string): NameSlots {
  const row = queryOne<{ name: string | null }>(
    stateDbPath,
    "SELECT json_extract(CAST(value AS TEXT), '$.name') AS name FROM cursorDiskKV WHERE key = ?",
    `composerData:${id}`,
  );
  return slotsFrom("cursor", [["toolTitle", row?.name]]);
}

// ── Copilot ──────────────────────────────────────────────────────────────────

function yamlScalar(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  const v = m?.[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  return v || undefined;
}

// workspace.yaml and session-store.db: the title slots only. `sessionDir` is
// <copilot home>/session-state/<id>.
export function readCopilotTitleSlots(sessionDir: string): NameSlots {
  const id = basename(sessionDir);
  let yaml = "";
  try {
    yaml = readFileSync(join(sessionDir, "workspace.yaml"), "utf8");
  } catch {}

  const name = yamlScalar(yaml, "name");
  if (name) {
    return slotsFrom("copilot", [
      [yamlScalar(yaml, "user_named") === "true" ? "userTitle" : "toolTitle", name],
    ]);
  }
  const row = queryOne<{ summary: string | null }>(
    join(dirname(dirname(sessionDir)), "session-store.db"),
    "SELECT summary FROM sessions WHERE id = ?",
    id,
  );
  return slotsFrom("copilot", [["toolTitle", row?.summary]]);
}

// The title slots plus the first user.message `.data.content` of events.jsonl
// (never `.data.transformedContent`, the prompt wrapped for the model).
export function readCopilotNameSlots(sessionDir: string): NameSlots {
  return {
    ...readCopilotTitleSlots(sessionDir),
    ...slotsFrom("copilot", [
      ["firstUserMessage", firstCopilotUserMessage(join(sessionDir, "events.jsonl"))],
    ]),
  };
}

function firstCopilotUserMessage(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    let pending = "";
    for (
      let n = readSync(fd, buf, 0, buf.length, null);
      n > 0;
      n = readSync(fd, buf, 0, buf.length, null)
    ) {
      pending += buf.toString("utf8", 0, n);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as { type?: string; data?: { content?: unknown } };
          if (e.type === "user.message" && typeof e.data?.content === "string")
            return e.data.content;
        } catch {}
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// ── Locating the stores from a transcript path ───────────────────────────────

// The stores are not under the roots a caller passes, they sit next to them
// (~/.codex/sessions vs ~/.codex/session_index.jsonl). Walk up from the
// transcript a bounded number of levels, so only ancestors of a file the caller
// already pointed at are touched.
function findUp(start: string, hasStore: (dir: string) => boolean, levels: number): string | null {
  let dir = start;
  for (let i = 0; i < levels; i++) {
    if (hasStore(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function codexNameSlotsFor(rolloutPath: string, id: string): NameSlots {
  const home = findUp(
    dirname(rolloutPath),
    (d) =>
      ["session_index.jsonl", "history.jsonl", "state_5.sqlite"].some((f) =>
        existsSync(join(d, f)),
      ),
    6,
  );
  return home ? readCodexNameSlots(home, id) : {};
}

// The IDE store is global to a Cursor install, not next to the transcripts, so
// it is configured once (ScanOptions.cursorStateDb) instead of located.
// ponytail: module state, so every parse path (scan, getConversation, a host
// tailing a file) sees it without threading an option through each one.
let cursorStateDb: string | undefined;

export function setCursorStateDb(path: string | undefined): void {
  cursorStateDb = path;
}

export function cursorNameSlotsFor(transcriptPath: string, id: string): NameSlots {
  const home = findUp(dirname(transcriptPath), (d) => existsSync(join(d, "chats")), 6);
  const cli = home ? readCursorCliNameSlots(join(home, "chats"), id) : {};
  // A CLI chat's own title wins; the (multi-GB) IDE db is only asked without one.
  if (cli.toolTitle || !cursorStateDb) return cli;
  return { ...cli, ...readCursorIdeNameSlots(cursorStateDb, id) };
}

export function copilotNameSlotsFor(eventsPath: string): NameSlots {
  return readCopilotTitleSlots(dirname(eventsPath));
}

// What the side stores say about one provider transcript right now. The engine
// keeps the JSON of this beside the file's cursor, so a rename that changes no
// transcript byte still shows up as a difference and triggers a reparse.
export function nameStoreSlotsFor(
  provider: ScannerProviderName,
  filePath: string,
  sessionId: string,
): NameSlots {
  switch (provider) {
    case "codex-cli":
      return codexNameSlotsFor(filePath, sessionId);
    case "cursor":
      return cursorNameSlotsFor(filePath, basename(filePath, ".jsonl"));
    case "copilot":
      return copilotNameSlotsFor(filePath);
    default:
      return {};
  }
}
