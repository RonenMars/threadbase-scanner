import {
  extractTextContent,
  extractThinking,
  extractToolResultBlocks,
  extractToolUseBlocks,
  extractToolUseNames,
  hasImageBlocks,
  isOnlyToolResultContent,
  parseTeammateMessageTag,
} from "../parser";
import type {
  AttachmentSidecar,
  ConversationMessage,
  MessageMetadata,
  MessageSender,
  TeamInfo,
  ToolUseBlock,
} from "../types";

// Resumable, serializable state for the conversation line→message reduction.
// Mirrors parseConversation()'s loop so a full reduce equals a streamed parse,
// and so a bounded page read can resume an *equivalent* parse from a checkpoint
// by restoring the cross-line state (pending tool_use blocks + team info).
export interface ConvReducerState {
  cwd: string;
  sessionId: string;
  sessionName: string;
  latestTimestamp: string;
  lastPrompt: string;
  // id -> tool_use block, so a later tool_result line resolves its tool type.
  pendingToolUses: Record<string, ToolUseBlock>;
  // teamName -> info, collected as lines are read and applied to messages.
  teamInfo: Record<string, TeamInfo>;
}

export function initialConvState(): ConvReducerState {
  return {
    cwd: "",
    sessionId: "",
    sessionName: "",
    latestTimestamp: "",
    lastPrompt: "",
    pendingToolUses: {},
    teamInfo: {},
  };
}

// Fold one JSONL entry. Returns the produced ConversationMessage (its message
// index is the count of messages emitted so far), or null if the line produced
// no message. Mutates `state` (header fields + cross-line maps).
export function reduceConvLine(
  state: ConvReducerState,
  entry: Record<string, unknown>,
): ConversationMessage | null {
  if (entry.cwd && !state.cwd) state.cwd = entry.cwd as string;
  if (entry.sessionId && !state.sessionId) state.sessionId = entry.sessionId as string;
  if (entry.slug && !state.sessionName) state.sessionName = entry.slug as string;
  if (entry.timestamp) {
    const ts = entry.timestamp as string;
    if (!state.latestTimestamp || ts > state.latestTimestamp) state.latestTimestamp = ts;
  }

  const type = entry.type as string;

  if (type === "last-prompt") {
    if (entry.lastPrompt && !state.lastPrompt) state.lastPrompt = entry.lastPrompt as string;
    return null;
  }
  // system (incl. turn_duration), file-history-snapshot, etc. produce no message.
  if (type !== "user" && type !== "assistant") return null;
  if (entry.isMeta) return null;

  const msg = entry.message as Record<string, unknown> | undefined;

  const toolUseBlocks = extractToolUseBlocks(msg?.content);
  for (const block of toolUseBlocks) state.pendingToolUses[block.id] = block;

  const hasToolUseResult = type === "user" && entry.toolUseResult != null;
  const isToolResultOnly = hasToolUseResult && isOnlyToolResultContent(msg?.content);
  const content = extractTextContent(msg?.content);
  const thinking = type === "assistant" ? extractThinking(msg?.content) : null;
  const hasThinking = !!(thinking?.content || thinking?.signature);

  if (!(content || isToolResultOnly || toolUseBlocks.length > 0 || hasThinking)) return null;

  const metadata: MessageMetadata = {};
  if (msg?.model) metadata.model = msg.model as string;
  if (msg?.stop_reason !== undefined) metadata.stopReason = msg.stop_reason as string | null;
  if (entry.gitBranch) metadata.gitBranch = entry.gitBranch as string;
  if (entry.version) metadata.version = entry.version as string;

  const usage = msg?.usage as Record<string, number> | undefined;
  if (usage) {
    if (usage.input_tokens) metadata.inputTokens = usage.input_tokens;
    if (usage.output_tokens) metadata.outputTokens = usage.output_tokens;
    if (usage.cache_read_input_tokens) metadata.cacheReadTokens = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens)
      metadata.cacheCreationTokens = usage.cache_creation_input_tokens;
  }

  const toolUseNames = extractToolUseNames(msg?.content);
  if (toolUseNames.length > 0) metadata.toolUses = toolUseNames;
  if (toolUseBlocks.length > 0) metadata.toolUseBlocks = toolUseBlocks;

  if (isToolResultOnly) {
    const pending = new Map(Object.entries(state.pendingToolUses));
    const toolResultBlocks = extractToolResultBlocks(msg?.content, pending);
    if (toolResultBlocks.length > 0) {
      metadata.toolResults = toolResultBlocks;
      // A result consumes its tool_use: prune it so the cross-line map stays
      // bounded by IN-FLIGHT tool calls instead of growing with the file.
      // Unpruned, every checkpoint snapshot/serialization of this state costs
      // O(file) — the structuredClone stall on large live conversations.
      for (const block of toolResultBlocks) delete state.pendingToolUses[block.toolUseId];
    }
  }

  if (entry.teamName) {
    metadata.teamName = entry.teamName as string;
    if (!state.teamInfo[metadata.teamName] && content) {
      const info = parseTeammateMessageTag(content);
      if (info) state.teamInfo[metadata.teamName] = info;
    }
  }

  const thinkingContent = thinking?.content || undefined;
  const thinkingSignature = thinking?.signature || undefined;
  const hasMetadata = Object.keys(metadata).length > 0;

  return {
    role: type as MessageSender,
    text: content || "",
    timestamp: (entry.timestamp as string) || "",
    uuid: (entry.uuid as string) || undefined,
    metadata: hasMetadata ? metadata : undefined,
    isToolResult: isToolResultOnly || undefined,
    isThinking: thinkingContent || thinkingSignature ? true : undefined,
    thinkingContent,
    thinkingSignature,
    parentUuid: entry.parentUuid !== undefined ? (entry.parentUuid as string | null) : undefined,
    requestId: type === "assistant" ? (entry.requestId as string | undefined) : undefined,
    promptId: type === "user" ? (entry.promptId as string | undefined) : undefined,
    isSidechain: typeof entry.isSidechain === "boolean" ? entry.isSidechain : undefined,
    permissionMode: type === "user" ? (entry.permissionMode as string | undefined) : undefined,
    hasImages: hasImageBlocks(msg?.content) || undefined,
    attachment:
      entry.attachment !== undefined ? (entry.attachment as AttachmentSidecar) : undefined,
  };
}

// Parse/classify one raw JSONL line — the exact line→message mapping the
// scanner uses internally, exported for downstream indexers (e.g. a watcher
// tailing appended lines) so their semantics cannot drift from the scanner's.
// Returns the produced ConversationMessage, or null when the line yields none
// (system/summary/sidecar records, blank or malformed lines). Whether a line
// produces a message — and its core fields (role, uuid, timestamp) — is
// state-independent, so calls without `state` classify correctly on their own;
// pass one shared `state` across successive lines of a file to also resolve
// cross-line references (tool_result → tool_use types, team info) identically
// to a full parse.
export function parseJsonlLine(
  line: string,
  state: ConvReducerState = initialConvState(),
): ConversationMessage | null {
  const text = line.trimEnd();
  if (text.trim().length === 0) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(text);
  } catch {
    return null;
  }
  return reduceConvLine(state, entry);
}

// Back-apply collected team info to a set of messages (the post-pass
// parseConversation does). Safe to call on a window: teamInfo for a given name
// is stable once first seen, so a window restored from a checkpoint that
// carries earlier teamInfo gets the same result.
export function applyTeamInfo(messages: ConversationMessage[], state: ConvReducerState): void {
  if (Object.keys(state.teamInfo).length === 0) return;
  for (const m of messages) {
    const name = m.metadata?.teamName;
    if (name && state.teamInfo[name] && m.metadata) m.metadata.teamInfo = state.teamInfo[name];
  }
}
