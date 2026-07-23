import { basename, dirname, join } from "path";
import {
  collectToolNames,
  extractTextContent,
  extractThinking,
  extractToolUseBlocks,
  isOnlyToolResultContent,
  isTeammateContent,
} from "../parser";
import { CLAUDE_CODE_PROVIDER } from "../providers/provider";
import type { ContentTier, ConversationMeta, MessageSender, MessageSnapshot } from "../types";

// Serializable fold state for incremental metadata indexing. parseMeta()'s
// per-line loop is expressed as reduceLine(state, entry); finalizeMeta(state)
// produces the ConversationMeta. Because the state is plain JSON, it can be
// persisted in conversation_files.reducer_state and resumed when a file grows,
// so an append only needs to fold the newly-read lines.
export interface ReducerState {
  sessionId: string;
  sessionName: string;
  latestTimestamp: string;
  cwd: string;
  teamName: string;
  model: string | null;
  messageCount: number;
  // Count of messages parseConversation() would produce — broader than
  // messageCount (also counts tool_use-only and thinking-only lines). Used as
  // the page total for bounded reads, since metadata messageCount differs.
  pageMessageCount: number;
  lastMessageSender: MessageSender;
  isTeammate: boolean;
  firstUserSeen: boolean;
  firstMessage: MessageSnapshot | null;
  lastMessage: MessageSnapshot | null;
  lastPrompt: string;
  toolNames: string[];
  previewParts: string[];
  snippetParts: string[];
  previewLength: number;
  snippetLength: number;
  badJsonLines: number;
}

export function initialReducerState(): ReducerState {
  return {
    sessionId: "",
    sessionName: "",
    latestTimestamp: "",
    cwd: "",
    teamName: "",
    model: null,
    messageCount: 0,
    lastMessageSender: "user",
    isTeammate: false,
    firstUserSeen: false,
    firstMessage: null,
    lastMessage: null,
    lastPrompt: "",
    pageMessageCount: 0,
    toolNames: [],
    previewParts: [],
    snippetParts: [],
    previewLength: 0,
    snippetLength: 0,
    badJsonLines: 0,
  };
}

// Fold one already-parsed JSONL entry into the state, mutating it in place.
// Mirrors parseMeta()'s loop body exactly so a full reduce equals a streamed
// parseMeta. `entry` is the JSON.parse() of one non-empty line.
export function reduceLine(
  state: ReducerState,
  entry: Record<string, unknown>,
  tier: ContentTier,
): void {
  if (entry.cwd && !state.cwd) state.cwd = entry.cwd as string;
  if (entry.sessionId && !state.sessionId) state.sessionId = entry.sessionId as string;
  if (entry.slug && !state.sessionName) state.sessionName = entry.slug as string;
  if (entry.teamName && !state.teamName) state.teamName = entry.teamName as string;
  if (entry.timestamp) {
    const ts = entry.timestamp as string;
    if (!state.latestTimestamp || ts > state.latestTimestamp) state.latestTimestamp = ts;
  }

  const type = entry.type as string;

  if (type === "last-prompt") {
    if (entry.lastPrompt && !state.lastPrompt) state.lastPrompt = entry.lastPrompt as string;
    return;
  }

  // file-history-snapshot and other non-message entries are excluded.
  if (type !== "user" && type !== "assistant") return;
  if (entry.isMeta) return;

  const msg = entry.message as Record<string, unknown> | undefined;

  if (state.model === null && msg?.model) state.model = msg.model as string;

  if (type === "user" && !state.firstUserSeen) {
    state.firstUserSeen = true;
    if (isTeammateContent(msg?.content)) state.isTeammate = true;
  }

  const content = extractTextContent(msg?.content);
  const hasToolUseResult = type === "user" && entry.toolUseResult != null;
  const isOnlyToolResult = hasToolUseResult && isOnlyToolResultContent(msg?.content);

  const toolSet = new Set(state.toolNames);
  collectToolNames(msg?.content, toolSet);
  state.toolNames = Array.from(toolSet);

  // Count messages the same way parseConversation does, so bounded paging has a
  // correct total. (Broader than messageCount: includes tool_use-only and
  // thinking-only lines.)
  const toolUseBlocks = extractToolUseBlocks(msg?.content);
  const thinking = type === "assistant" ? extractThinking(msg?.content) : null;
  const hasThinking = !!(thinking?.content || thinking?.signature);
  if (content || isOnlyToolResult || toolUseBlocks.length > 0 || hasThinking) {
    state.pageMessageCount++;
  }

  if (content || isOnlyToolResult) {
    state.messageCount++;
    state.lastMessageSender = type as MessageSender;

    if (content) {
      const ts = (entry.timestamp as string) || "";
      if (!state.firstMessage) state.firstMessage = { text: content.slice(0, 200), timestamp: ts };
      state.lastMessage = { text: content.slice(0, 200), timestamp: ts };

      if (state.previewLength < tier.previewMax) {
        state.previewParts.push(content);
        state.previewLength += content.length;
      }
      if (state.snippetLength < tier.snippetMax) {
        const remaining = tier.snippetMax - state.snippetLength;
        const chunk = content.length > remaining ? content.slice(0, remaining) : content;
        state.snippetParts.push(chunk);
        state.snippetLength += chunk.length;
      }
    }
  }
}

// Build the ConversationMeta from accumulated state, or null when no messages
// were seen — matching parseMeta()'s final shape exactly.
export function finalizeMeta(
  state: ReducerState,
  filePath: string,
  account: string,
  tier: ContentTier,
): ConversationMeta | null {
  if (state.messageCount === 0) return null;

  const isSubagent = filePath.includes("/subagents/");
  let parentSessionId: string | null = null;
  if (isSubagent) {
    const uuidDir = dirname(dirname(filePath));
    parentSessionId = join(dirname(uuidDir), `${basename(uuidDir)}.jsonl`);
  }

  const projectPath = state.cwd;
  return {
    id: filePath,
    filePath,
    provider: CLAUDE_CODE_PROVIDER,
    sessionId: state.sessionId || basename(filePath, ".jsonl"),
    sessionName: state.sessionName || deriveSessionNameFromFirstMessage(state.firstMessage),
    projectPath,
    projectName: getShortProjectName(projectPath),
    account,
    timestamp: state.latestTimestamp || new Date().toISOString(),
    messageCount: state.messageCount,
    lastMessageSender: state.lastMessageSender,
    preview: state.previewParts.join(" ").slice(0, tier.previewMax),
    contentSnippet: state.snippetParts.join(" "),
    gitBranch: null,
    model: state.model,
    isSubagent,
    parentSessionId,
    isTeammate: state.isTeammate,
    teamName: state.teamName || null,
    toolNames: state.toolNames,
    firstMessage: state.firstMessage,
    lastMessage: state.lastMessage,
    lastPrompt: state.lastPrompt || undefined,
  };
}

// Fallback session name for interactive Claude Code conversations, which carry
// no `slug` (only SDK/agent sessions do). The first user message is the only
// human-readable name source in a normal JSONL, so use its first line, trimmed
// to a title-sized length. Empty when there is no message text.
export function deriveSessionNameFromFirstMessage(firstMessage: { text: string } | null): string {
  const firstLine = firstMessage?.text.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.slice(0, 80);
}

function getShortProjectName(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}
