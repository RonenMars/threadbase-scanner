import type { Database } from "better-sqlite3";
import type { ConversationMeta, MessageSender } from "../../types";

export interface ConversationRow {
  id: number;
  file_id: number;
  source_path: string;
  session_id: string;
  session_name: string | null;
  project_path: string | null;
  project_name: string | null;
  account: string;
  branch: string | null;
  preview: string | null;
  content_snippet: string | null;
  message_count: number;
  last_message_sender: string;
  timestamp: string | null;
  first_sent_at: string | null;
  first_sent_text: string | null;
  last_sent_at: string | null;
  last_sent_text: string | null;
  model: string | null;
  is_subagent: number;
  parent_session_id: string | null;
  is_teammate: number;
  team_name: string | null;
  tool_names_json: string | null;
  last_prompt: string | null;
  status: string;
}

// Row -> ConversationMeta. Must reproduce the exact in-memory shape so the
// persistent and legacy paths return identical ScanResult/SearchResult objects.
export function rowToMeta(row: ConversationRow): ConversationMeta {
  return {
    id: row.source_path,
    filePath: row.source_path,
    sessionId: row.session_id,
    sessionName: row.session_name ?? "",
    projectPath: row.project_path ?? "",
    projectName: row.project_name ?? "",
    account: row.account,
    timestamp: row.timestamp ?? "",
    messageCount: row.message_count,
    lastMessageSender: row.last_message_sender as MessageSender,
    preview: row.preview ?? "",
    contentSnippet: row.content_snippet ?? "",
    gitBranch: row.branch,
    model: row.model,
    isSubagent: row.is_subagent === 1,
    parentSessionId: row.parent_session_id,
    isTeammate: row.is_teammate === 1,
    teamName: row.team_name,
    toolNames: row.tool_names_json ? (JSON.parse(row.tool_names_json) as string[]) : [],
    firstMessage: row.first_sent_text
      ? { text: row.first_sent_text, timestamp: row.first_sent_at ?? "" }
      : null,
    lastMessage: row.last_sent_text
      ? { text: row.last_sent_text, timestamp: row.last_sent_at ?? "" }
      : null,
    lastPrompt: row.last_prompt ?? undefined,
  };
}

export class ConversationsRepo {
  constructor(private db: Database) {}

  // Upsert by file_id (1 file = 1 conversation). Keyed on the unique file_id so
  // a re-index overwrites the prior summary in place.
  upsert(fileId: number, meta: ConversationMeta): void {
    this.db
      .prepare(
        `INSERT INTO conversations (
           file_id, source_path, session_id, session_name, project_path, project_name,
           account, branch, preview, content_snippet, message_count, last_message_sender,
           timestamp, first_sent_at, first_sent_text, last_sent_at, last_sent_text,
           model, is_subagent, parent_session_id, is_teammate, team_name, tool_names_json,
           last_prompt, status, updated_at
         ) VALUES (
           @file_id, @source_path, @session_id, @session_name, @project_path, @project_name,
           @account, @branch, @preview, @content_snippet, @message_count, @last_message_sender,
           @timestamp, @first_sent_at, @first_sent_text, @last_sent_at, @last_sent_text,
           @model, @is_subagent, @parent_session_id, @is_teammate, @team_name, @tool_names_json,
           @last_prompt, 'active', CURRENT_TIMESTAMP
         )
         ON CONFLICT(file_id) DO UPDATE SET
           source_path = excluded.source_path,
           session_id = excluded.session_id,
           session_name = excluded.session_name,
           project_path = excluded.project_path,
           project_name = excluded.project_name,
           account = excluded.account,
           branch = excluded.branch,
           preview = excluded.preview,
           content_snippet = excluded.content_snippet,
           message_count = excluded.message_count,
           last_message_sender = excluded.last_message_sender,
           timestamp = excluded.timestamp,
           first_sent_at = excluded.first_sent_at,
           first_sent_text = excluded.first_sent_text,
           last_sent_at = excluded.last_sent_at,
           last_sent_text = excluded.last_sent_text,
           model = excluded.model,
           is_subagent = excluded.is_subagent,
           parent_session_id = excluded.parent_session_id,
           is_teammate = excluded.is_teammate,
           team_name = excluded.team_name,
           tool_names_json = excluded.tool_names_json,
           last_prompt = excluded.last_prompt,
           status = 'active',
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run({
        file_id: fileId,
        source_path: meta.id,
        session_id: meta.sessionId,
        session_name: meta.sessionName || null,
        project_path: meta.projectPath || null,
        project_name: meta.projectName || null,
        account: meta.account,
        branch: meta.gitBranch,
        preview: meta.preview || null,
        content_snippet: meta.contentSnippet || null,
        message_count: meta.messageCount,
        last_message_sender: meta.lastMessageSender,
        timestamp: meta.timestamp || null,
        first_sent_at: meta.firstMessage?.timestamp ?? null,
        first_sent_text: meta.firstMessage?.text ?? null,
        last_sent_at: meta.lastMessage?.timestamp ?? null,
        last_sent_text: meta.lastMessage?.text ?? null,
        model: meta.model,
        is_subagent: meta.isSubagent ? 1 : 0,
        parent_session_id: meta.parentSessionId,
        is_teammate: meta.isTeammate ? 1 : 0,
        team_name: meta.teamName,
        tool_names_json: JSON.stringify(meta.toolNames),
        last_prompt: meta.lastPrompt ?? null,
      });
  }

  getBySourcePath(sourcePath: string): ConversationMeta | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE source_path = ? AND status = 'active'")
      .get(sourcePath) as ConversationRow | undefined;
    return row ? rowToMeta(row) : null;
  }

  // Dual lookup matching scanner.getConversation: resolve by source_path (==id)
  // first, then by session_id (most-recent wins, mirroring the in-memory map's
  // last-writer-wins behavior).
  getByIdOrSession(id: string): ConversationMeta | null {
    const direct = this.getBySourcePath(id);
    if (direct) return direct;
    const row = this.db
      .prepare(
        `SELECT * FROM conversations WHERE session_id = ? AND status = 'active'
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(id) as ConversationRow | undefined;
    return row ? rowToMeta(row) : null;
  }

  // All active metas (unsorted/unfiltered) — callers apply the existing
  // filters/view transforms. Used by scan() before SQL filtering is wired in.
  allActive(): ConversationMeta[] {
    const rows = this.db
      .prepare("SELECT * FROM conversations WHERE status = 'active'")
      .all() as ConversationRow[];
    return rows.map(rowToMeta);
  }

  distinctProjects(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT project_path FROM conversations
         WHERE status = 'active' AND project_path IS NOT NULL AND project_path != ''
         ORDER BY project_path ASC`,
      )
      .all() as { project_path: string }[];
    return rows.map((r) => r.project_path);
  }

  deleteByFileId(fileId: number): void {
    this.db
      .prepare(
        "UPDATE conversations SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE file_id = ?",
      )
      .run(fileId);
  }

  count(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE status = 'active'").get() as {
        n: number;
      }
    ).n;
  }
}
