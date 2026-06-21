// ─── Primitives ─────────────────────────────────────────────────────

export type MessageSender = "user" | "assistant";
export type Include = "all" | "conversations" | "subagents" | "teammates";
export type View = "flat" | "tree" | "grouped";
export type SortOrder = "recent" | "oldest" | "messages-desc" | "messages-asc" | "alpha";

export const VALID_SORT_ORDERS: SortOrder[] = [
  "recent",
  "oldest",
  "messages-desc",
  "messages-asc",
  "alpha",
];

// ─── Profile ────────────────────────────────────────────────────────

export interface Profile {
  id: string;
  label: string;
  configDir: string;
  enabled: boolean;
  emoji?: string;
  scanHistory?: boolean;
}

// ─── Content Tiers ──────────────────────────────────────────────────

export interface ContentTier {
  name: string;
  previewMax: number;
  snippetMax: number;
}

// ─── ConversationMeta (full superset) ───────────────────────────────

export interface MessageSnapshot {
  text: string;
  timestamp: string;
}

export type ProviderName = "claude-code" | "codex-cli";

export interface ConversationMeta {
  id: string;
  filePath: string;
  sessionId: string;
  // Which provider produced this meta. Optional/additive: existing Threadbase
  // metas default to "threadbase" when unset.
  provider?: ProviderName;
  // Distinguishes plain chat conversations from task-oriented logs (Codex).
  kind?: "conversation" | "task";
  // Provider-native session id when it differs from the (non-unique) sessionId.
  externalSessionId?: string;
  sessionName: string;
  projectPath: string;
  projectName: string;
  account: string;
  timestamp: string;
  messageCount: number;
  lastMessageSender: MessageSender;
  preview: string;
  contentSnippet: string;
  gitBranch: string | null;
  model: string | null;
  isSubagent: boolean;
  parentSessionId: string | null;
  isTeammate: boolean;
  teamName: string | null;
  toolNames: string[];
  firstMessage: MessageSnapshot | null;
  lastMessage: MessageSnapshot | null;
  lastPrompt?: string;
}

// ─── View Variants ──────────────────────────────────────────────────

export interface TreeConversation extends ConversationMeta {
  subagents: ConversationMeta[];
}

export interface GroupedConversations {
  [groupKey: string]: ConversationMeta[];
}

// ─── Options ────────────────────────────────────────────────────────

export interface FileStatEntry {
  mtimeMs: number;
  size: number;
}

export interface ScanOptions {
  profiles?: Profile[];
  // Providers to scan. Defaults to ["threadbase"]. Including "codex-cli"
  // requires codexRoots (no default home scan).
  providers?: ProviderName[];
  // Absolute roots to discover Codex CLI history under (e.g. ~/.codex/sessions).
  codexRoots?: string[];
  tier?: string;
  tiers?: Record<string, ContentTier>;
  include?: Include;
  view?: View;
  sort?: SortOrder;
  since?: string;
  project?: string;
  account?: string;
  limit?: number;
  offset?: number;
  onProgress?: (scanned: number, total: number) => void;
  onBatch?: (metas: ConversationMeta[]) => void;
  /** Known file stats from a previous scan. Files whose (mtimeMs, size) match
   *  are skipped — the cached ConversationMeta is reused instead. */
  statCache?: Map<string, { stat: FileStatEntry; meta: ConversationMeta }>;
}

export interface ScanResult {
  conversations: ConversationMeta[] | TreeConversation[] | GroupedConversations;
  total: number;
  scanned: number;
}

export interface SearchOptions extends ScanOptions {
  fields?: string[];
  // Restrict results to one provider.
  provider?: ProviderName;
}

export interface SearchMatch {
  field: string;
  snippet: string;
}

export interface SearchResult {
  meta: ConversationMeta;
  score: number;
  matches: SearchMatch[];
}

export interface GetConversationOptions {
  profiles?: Profile[];
}

export interface GetConversationPageOptions {
  beforeIndex?: number;
  limit: number;
}

export interface ConversationPage {
  messages: ConversationMessage[];
  total: number;
  fromIndex: number;
}

// A page sliced directly from a single parsed JSONL file, carrying the parsed
// Conversation alongside the window so a caller can build a full response
// (meta + messages) from one parse, without a prior scan().
export interface SingleFilePage extends ConversationPage {
  conversation: Conversation;
}

// ─── Full Conversation ──────────────────────────────────────────────

export interface TurnDuration {
  durationMs: number;
  messageCount: number;
  uuid?: string;
}

export interface DeferredToolsDeltaAttachment {
  type: "deferred_tools_delta";
  addedNames: string[];
  addedLines: unknown[];
  removedNames: string[];
}

export type AttachmentSidecar =
  | DeferredToolsDeltaAttachment
  | { type: string; [key: string]: unknown };

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  toolUseId: string;
  type:
    | "edit"
    | "write"
    | "read"
    | "bash"
    | "grep"
    | "glob"
    | "taskAgent"
    | "taskCreate"
    | "taskUpdate"
    | "generic";
  content: Record<string, unknown>;
  isError?: boolean;
}

export interface TeamInfo {
  teammateId: string;
  summary?: string;
  color?: string;
}

export interface MessageMetadata {
  model?: string;
  stopReason?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  gitBranch?: string;
  version?: string;
  toolUses?: string[];
  toolUseBlocks?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
  teamName?: string;
  teamInfo?: TeamInfo;
}

export interface ConversationMessage {
  role: MessageSender;
  text: string;
  timestamp: string;
  uuid?: string;
  metadata?: MessageMetadata;
  isToolResult?: boolean;
  isThinking?: boolean;
  thinkingContent?: string;
  thinkingSignature?: string;
  parentUuid?: string | null;
  requestId?: string;
  promptId?: string;
  isSidechain?: boolean;
  permissionMode?: string;
  hasImages?: boolean;
  attachment?: AttachmentSidecar;
}

export interface Conversation {
  id: string;
  filePath: string;
  projectPath: string;
  projectName: string;
  sessionId: string;
  sessionName: string;
  messages: ConversationMessage[];
  fullText: string;
  timestamp: string;
  messageCount: number;
  account: string;
  turnDurations?: TurnDuration[];
  lastPrompt?: string;
}
