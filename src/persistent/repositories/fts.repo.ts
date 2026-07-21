import type { Database } from "better-sqlite3";
import { canonicalPath } from "../../canonical-path";
import type { ConversationMeta } from "../../types";

// FTS5-backed search index over conversation content + metadata. One row per
// conversation, keyed by source_path (== ConversationMeta.id). Replaced on each
// upsert so a re-index never leaves stale text behind.
export class FtsRepo {
  constructor(private db: Database) {}

  upsert(meta: ConversationMeta): void {
    // Canonical form, matching conversations.source_path — a search hit is
    // resolved back through getBySourcePath(), so the two must agree.
    const sourcePath = canonicalPath(meta.id);
    const tx = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM conversation_messages_fts WHERE source_path = ?")
        .run(sourcePath);
      this.db
        .prepare(
          `INSERT INTO conversation_messages_fts
             (source_path, content, project_name, session_id, session_name, account, model, branch, tool_names)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sourcePath,
          meta.contentSnippet ?? "",
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

  remove(sourcePath: string): void {
    this.db
      .prepare("DELETE FROM conversation_messages_fts WHERE source_path = ?")
      .run(canonicalPath(sourcePath));
  }

  // Ranked source_paths matching the query, best first. Returns [] on an empty
  // query (callers fall back to a recency listing).
  search(query: string, limit: number): string[] {
    const match = toMatchQuery(query);
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT source_path FROM conversation_messages_fts
         WHERE conversation_messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit) as { source_path: string }[];
    return rows.map((r) => r.source_path);
  }

  count(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM conversation_messages_fts").get() as { n: number }
    ).n;
  }
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
