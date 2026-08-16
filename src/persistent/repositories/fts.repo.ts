import type { Database } from "better-sqlite3";
import { canonicalPath } from "../../canonical-path";
import type { SearchDocument } from "../../search-document";
import {
  FTS_ELLIPSIS,
  FTS_HIT_CLOSE,
  FTS_HIT_OPEN,
  FTS_SNIPPET_TOKENS,
  parseFtsSnippet,
} from "../../search-matches";
import type { ConversationMeta, SearchHighlight } from "../../types";

// Body column positions in conversation_messages_fts, in snippet() priority
// order. source_path is column 0.
const BODY_COLUMNS = [
  { name: "text", index: 1 },
  { name: "thinking", index: 2 },
  { name: "tools", index: 3 },
] as const;

export interface FtsSearchFilters {
  account?: string;
  provider?: string;
  project?: string;
  since?: Date;
  include?: "all" | "conversations" | "subagents" | "teammates";
}

export interface FtsHit {
  sourcePath: string;
  // Present when the match was in a body column. Null for a metadata-only hit,
  // which the caller resolves through generateMatches() instead.
  body: { snippet: string; highlights: SearchHighlight[] } | null;
}

// FTS5-backed search index over conversation body + metadata. One row per
// conversation, addressed by rowid == conversation_files.id.
//
// Never look a row up by source_path: FTS5's planner handles only MATCH, rowid
// and rank, so any other constraint linear-scans the table. That was tolerable
// when a row held <=5 KB; with ~128 KB of body per row it would scan the whole
// corpus on every append.
export class FtsRepo {
  constructor(private db: Database) {}

  upsert(rowId: number, meta: ConversationMeta, doc: SearchDocument): void {
    // Canonical form, matching conversations.source_path — a search hit is
    // resolved back through getBySourcePath(), so the two must agree.
    const sourcePath = canonicalPath(meta.id);
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM conversation_messages_fts WHERE rowid = ?").run(rowId);
      this.db
        .prepare(
          `INSERT INTO conversation_messages_fts
             (rowid, source_path, text, thinking, tools,
              project_name, session_id, session_name, account, model, branch, tool_names)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rowId,
          sourcePath,
          doc.text,
          doc.thinking,
          doc.tools,
          meta.projectName ?? "",
          meta.sessionId ?? "",
          meta.sessionName ?? "",
          meta.account ?? "",
          meta.model ?? "",
          meta.gitBranch ?? "",
          meta.toolNames.join(" "),
        );
    });
    tx();
  }

  // Current durable buckets for a conversation, so an append can tail-extend
  // them without reparsing the file. Returns null when no row exists yet.
  readDocument(rowId: number): SearchDocument | null {
    const row = this.db
      .prepare("SELECT text, thinking, tools FROM conversation_messages_fts WHERE rowid = ?")
      .get(rowId) as { text: string; thinking: string; tools: string } | undefined;
    if (!row) return null;
    return { text: row.text ?? "", thinking: row.thinking ?? "", tools: row.tools ?? "" };
  }

  // True when the stored row already equals what we would write, so an append
  // can skip re-tokenizing ~128 KB of body for nothing.
  //
  // The check covers the metadata columns too, not just the buckets: a
  // newly-seen tool name or a late-resolved session_name changes metadata while
  // the body is byte-identical, and nothing else ever rewrites this row — so
  // skipping on "body unchanged" alone would strand that stale value forever.
  isCurrent(rowId: number, meta: ConversationMeta, doc: SearchDocument): boolean {
    const row = this.db
      .prepare(
        `SELECT text, thinking, tools,
                project_name, session_id, session_name, account, model, branch, tool_names
         FROM conversation_messages_fts WHERE rowid = ?`,
      )
      .get(rowId) as Record<string, string> | undefined;
    if (!row) return false;

    return (
      row.text === doc.text &&
      row.thinking === doc.thinking &&
      row.tools === doc.tools &&
      row.project_name === (meta.projectName ?? "") &&
      row.session_id === (meta.sessionId ?? "") &&
      row.session_name === (meta.sessionName ?? "") &&
      row.account === (meta.account ?? "") &&
      row.model === (meta.model ?? "") &&
      row.branch === (meta.gitBranch ?? "") &&
      row.tool_names === meta.toolNames.join(" ")
    );
  }

  remove(rowId: number): void {
    this.db.prepare("DELETE FROM conversation_messages_fts WHERE rowid = ?").run(rowId);
  }

  // Ranked hits matching the query, best first. Filters run in SQL BEFORE LIMIT:
  // with a wide corpus a popular term matches far more conversations than one
  // page, so post-filtering an already-truncated list would report "no results"
  // for queries that do have them.
  search(query: string, limit: number, filters: FtsSearchFilters = {}): FtsHit[] {
    const match = toMatchQuery(query);
    if (!match) return [];

    const snippetSelects = BODY_COLUMNS.map(
      (c) => `snippet(conversation_messages_fts, ${c.index}, ?, ?, ?, ?) AS snippet_${c.name}`,
    ).join(", ");

    const params: unknown[] = [];
    for (const _col of BODY_COLUMNS) {
      params.push(FTS_HIT_OPEN, FTS_HIT_CLOSE, FTS_ELLIPSIS, FTS_SNIPPET_TOKENS);
    }
    params.push(match);

    const where: string[] = ["conversation_messages_fts MATCH ?", "c.status = 'active'"];

    if (filters.account) {
      where.push("c.account = ?");
      params.push(filters.account);
    }
    if (filters.provider) {
      where.push("c.provider = ?");
      params.push(filters.provider);
    }
    if (filters.project) {
      where.push("(lower(c.project_path) LIKE ? OR lower(c.project_name) LIKE ?)");
      const like = `%${filters.project.toLowerCase()}%`;
      params.push(like, like);
    }
    if (filters.since) {
      where.push("c.timestamp >= ?");
      params.push(filters.since.toISOString());
    }
    if (filters.include === "conversations") {
      where.push("c.is_subagent = 0 AND c.is_teammate = 0");
    } else if (filters.include === "subagents") {
      where.push("c.is_subagent = 1");
    } else if (filters.include === "teammates") {
      where.push("c.is_teammate = 1");
    }

    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT conversation_messages_fts.source_path AS source_path, ${snippetSelects}
         FROM conversation_messages_fts
         JOIN conversations c ON c.source_path = conversation_messages_fts.source_path
         WHERE ${where.join(" AND ")}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params) as Record<string, string>[];

    return rows.map((row) => ({ sourcePath: row.source_path, body: pickBodySnippet(row) }));
  }

  count(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM conversation_messages_fts").get() as { n: number }
    ).n;
  }
}

// snippet() returns a column's head even when the match was elsewhere, so the
// hit markers are the only signal that THIS column matched. Take the first
// marked column in priority order: text, then thinking, then tools.
function pickBodySnippet(row: Record<string, string>) {
  for (const col of BODY_COLUMNS) {
    const parsed = parseFtsSnippet(row[`snippet_${col.name}`]);
    if (parsed) return parsed;
  }
  return null;
}

// Turn free-text into a safe FTS5 prefix query. Each whitespace-separated term
// is wrapped in double quotes (so FTS5 special chars are treated literally) and
// suffixed with * for prefix matching, mirroring FlexSearch's forward tokenizer.
// Terms are ANDed together. Returns "" when nothing usable remains.
function toMatchQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t}"*`).join(" AND ");
}
