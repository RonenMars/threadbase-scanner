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

export interface ConversationMeta {
  id: string;
  filePath: string;
  sessionId: string;
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
}

// ─── View Variants ──────────────────────────────────────────────────

export interface TreeConversation extends ConversationMeta {
  subagents: ConversationMeta[];
}

export interface GroupedConversations {
  [groupKey: string]: ConversationMeta[];
}

// ─── Options ────────────────────────────────────────────────────────

export interface ScanOptions {
  profiles?: Profile[];
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
}

export interface ScanResult {
  conversations: ConversationMeta[] | TreeConversation[] | GroupedConversations;
  total: number;
  scanned: number;
}

export interface SearchOptions extends ScanOptions {
  fields?: string[];
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

// ─── Full Conversation ──────────────────────────────────────────────

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
}
