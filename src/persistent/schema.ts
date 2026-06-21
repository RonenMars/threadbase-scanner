// Persistent index schema for @threadbase-sh/scanner.
//
// Embedded as a string (not a sibling .sql file) so it survives tsup bundling
// into dist/ without runtime file I/O.
//
// One JSONL file == one conversation, so conversation_files.id maps 1:1 to
// conversations.file_id.
//
// NOTE: session_id is intentionally NOT unique. parseMeta() falls back to the
// file's basename when a line carries no sessionId, and resumed/subagent
// sessions can repeat a sessionId across files. The stable unique key is the
// file's absolute_path (and conversations.file_id).

// Bumped whenever DDL below changes; drives migrations.ts via PRAGMA user_version.
export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  absolute_path TEXT NOT NULL UNIQUE,
  parent_dir TEXT NOT NULL,
  file_name TEXT NOT NULL,

  account TEXT NOT NULL DEFAULT 'default',

  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,

  last_indexed_offset INTEGER NOT NULL DEFAULT 0,
  last_indexed_line INTEGER NOT NULL DEFAULT 0,

  reducer_state TEXT,

  content_fingerprint TEXT,

  status TEXT NOT NULL DEFAULT 'active',

  last_indexed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversation_files_status ON conversation_files(status);
CREATE INDEX IF NOT EXISTS idx_conversation_files_parent_dir ON conversation_files(parent_dir);
CREATE INDEX IF NOT EXISTS idx_conversation_files_account ON conversation_files(account);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  file_id INTEGER NOT NULL UNIQUE,

  source_path TEXT NOT NULL UNIQUE,
  -- Which provider produced this row. Canonical identity is (provider,
  -- source_path); session_id stays non-unique across providers too.
  provider TEXT NOT NULL DEFAULT 'claude-code',
  kind TEXT,
  external_session_id TEXT,
  session_id TEXT NOT NULL,
  session_name TEXT,

  project_path TEXT,
  project_name TEXT,
  account TEXT NOT NULL DEFAULT 'default',
  branch TEXT,

  preview TEXT,
  content_snippet TEXT,

  message_count INTEGER NOT NULL DEFAULT 0,
  -- Count of messages parseConversation() produces (broader than message_count;
  -- includes tool_use-only and thinking-only lines). The total for bounded paging.
  page_message_count INTEGER NOT NULL DEFAULT 0,
  last_message_sender TEXT NOT NULL DEFAULT 'user',
  timestamp TEXT,

  -- Monotonic write counter; the highest value is the most recently indexed
  -- row. Drives last-writer-wins resolution for shared session_ids (matching
  -- the in-memory sessionId map), at the sub-second precision updated_at lacks.
  index_seq INTEGER NOT NULL DEFAULT 0,

  first_sent_at TEXT,
  first_sent_text TEXT,

  last_sent_at TEXT,
  last_sent_text TEXT,

  model TEXT,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT,
  is_teammate INTEGER NOT NULL DEFAULT 0,
  team_name TEXT,
  tool_names_json TEXT,
  last_prompt TEXT,

  status TEXT NOT NULL DEFAULT 'active',

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (file_id) REFERENCES conversation_files(id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_session_id ON conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_provider_session ON conversations(provider, session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_provider_recent ON conversations(provider, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_provider_project_branch ON conversations(provider, project_path, branch);
CREATE INDEX IF NOT EXISTS idx_conversations_recent ON conversations(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_project_recent ON conversations(project_path, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_project_branch_recent ON conversations(project_path, branch, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_account_recent ON conversations(account, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_subagent_recent ON conversations(is_subagent, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_team_recent ON conversations(team_name, timestamp DESC);

-- Full-text search index over conversation content + metadata. Kept separate
-- from the metadata tables so list-screen queries stay small and fast.
-- source_path is UNINDEXED (stored, not tokenized) and links back to a
-- conversations row. One FTS row per conversation, replaced on each upsert.
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
  source_path UNINDEXED,
  content,
  project_name,
  session_id,
  session_name,
  account,
  model,
  branch,
  tool_names,
  tokenize = 'unicode61'
);

-- Seek index for large conversations: every N messages, record the byte offset
-- where the next message's line begins plus the parser's cross-line state
-- (pending tool_use blocks, team info) needed to resume an equivalent parse
-- from that point. Lets getConversationPage() read a window near the end of a
-- huge file without parsing from byte 0.
CREATE TABLE IF NOT EXISTS message_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  message_index INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL,
  line_number INTEGER NOT NULL,
  parser_state TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_message_checkpoints_lookup
  ON message_checkpoints(source_path, message_index);
`;
