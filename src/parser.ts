import { createReadStream } from "fs";
import { basename, dirname, join } from "path";
import { createInterface } from "readline";
import { cleanSystemTags } from "./tags";
import type {
  ContentTier,
  Conversation,
  ConversationMessage,
  ConversationMeta,
  MessageMetadata,
  MessageSender,
  TeamInfo,
  ToolUseBlock,
} from "./types";

export async function parseMeta(
  filePath: string,
  account: string,
  tier: ContentTier,
): Promise<ConversationMeta | null> {
  let sessionId = "";
  let sessionName = "";
  let latestTimestamp = "";
  let cwd = "";
  let teamName = "";
  let model: string | null = null;
  let messageCount = 0;
  let lastMessageSender: MessageSender = "user";
  let isTeammate = false;
  let firstUserSeen = false;
  const toolNameSet = new Set<string>();
  const previewParts: string[] = [];
  const snippetParts: string[] = [];
  let snippetLength = 0;
  let previewLength = 0;

  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.cwd && !cwd) cwd = entry.cwd as string;
      if (entry.sessionId && !sessionId) sessionId = entry.sessionId as string;
      if (entry.slug && !sessionName) sessionName = entry.slug as string;
      if (entry.teamName && !teamName) teamName = entry.teamName as string;
      if (entry.timestamp) {
        const ts = entry.timestamp as string;
        if (!latestTimestamp || ts > latestTimestamp) latestTimestamp = ts;
      }

      const type = entry.type as string;
      if (type !== "user" && type !== "assistant") continue;
      if (entry.isMeta) continue;

      // Extract model from first assistant message
      if (model === null) {
        const msg = entry.message as Record<string, unknown> | undefined;
        if (msg?.model) model = msg.model as string;
      }

      // Check for teammate in first user message
      if (type === "user" && !firstUserSeen) {
        firstUserSeen = true;
        if (isTeammateContent((entry.message as Record<string, unknown>)?.content)) {
          isTeammate = true;
        }
      }

      // Extract content
      const msg = entry.message as Record<string, unknown> | undefined;
      const content = extractTextContent(msg?.content);
      const hasToolUseResult = type === "user" && entry.toolUseResult != null;
      const isOnlyToolResult = hasToolUseResult && isOnlyToolResultContent(msg?.content);

      // Collect tool names
      collectToolNames(msg?.content, toolNameSet);

      if (content || isOnlyToolResult) {
        messageCount++;
        lastMessageSender = type as MessageSender;

        if (content) {
          if (previewLength < tier.previewMax) {
            previewParts.push(content);
            previewLength += content.length;
          }
          if (snippetLength < tier.snippetMax) {
            const remaining = tier.snippetMax - snippetLength;
            const chunk = content.length > remaining ? content.slice(0, remaining) : content;
            snippetParts.push(chunk);
            snippetLength += chunk.length;
          }
        }
      }
    }
  } catch {
    return null;
  }

  if (messageCount === 0) return null;

  const isSubagent = filePath.includes("/subagents/");
  let parentSessionId: string | null = null;
  if (isSubagent) {
    const uuidDir = dirname(dirname(filePath));
    parentSessionId = join(dirname(uuidDir), basename(uuidDir) + ".jsonl");
  }

  const projectPath = cwd;
  const preview = previewParts.join(" ").slice(0, tier.previewMax);

  return {
    id: filePath,
    filePath,
    sessionId: sessionId || basename(filePath, ".jsonl"),
    sessionName,
    projectPath,
    projectName: getShortProjectName(projectPath),
    account,
    timestamp: latestTimestamp || new Date().toISOString(),
    messageCount,
    lastMessageSender,
    preview,
    contentSnippet: snippetParts.join(" "),
    gitBranch: null,
    model,
    isSubagent,
    parentSessionId,
    isTeammate,
    teamName: teamName || null,
    toolNames: Array.from(toolNameSet),
  };
}

export async function parseConversation(
  filePath: string,
  account: string,
): Promise<Conversation | null> {
  const messages: ConversationMessage[] = [];
  let sessionId = "";
  let sessionName = "";
  let latestTimestamp = "";
  let cwd = "";
  const textParts: string[] = [];
  const pendingToolUses = new Map<string, ToolUseBlock>();
  const teamInfoMap = new Map<string, TeamInfo>();

  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.cwd && !cwd) cwd = entry.cwd as string;
      if (entry.sessionId && !sessionId) sessionId = entry.sessionId as string;
      if (entry.slug && !sessionName) sessionName = entry.slug as string;
      if (entry.timestamp) {
        const ts = entry.timestamp as string;
        if (!latestTimestamp || ts > latestTimestamp) latestTimestamp = ts;
      }

      const type = entry.type as string;
      if (type !== "user" && type !== "assistant") continue;
      if (entry.isMeta) continue;

      const msg = entry.message as Record<string, unknown> | undefined;

      // Track tool_use blocks from assistant messages
      const toolUseBlocks = extractToolUseBlocks(msg?.content);
      for (const block of toolUseBlocks) {
        pendingToolUses.set(block.id, block);
      }

      const hasToolUseResult = type === "user" && entry.toolUseResult != null;
      const isToolResultOnly = hasToolUseResult && isOnlyToolResultContent(msg?.content);

      const content = extractTextContent(msg?.content);

      if (content || isToolResultOnly || toolUseBlocks.length > 0) {
        const metadata: MessageMetadata = {};

        if (msg?.model) metadata.model = msg.model as string;
        if (msg?.stop_reason !== undefined) metadata.stopReason = msg.stop_reason as string | null;
        if (entry.gitBranch) metadata.gitBranch = entry.gitBranch as string;
        if (entry.version) metadata.version = entry.version as string;

        const usage = msg?.usage as Record<string, number> | undefined;
        if (usage) {
          if (usage.input_tokens) metadata.inputTokens = usage.input_tokens;
          if (usage.output_tokens) metadata.outputTokens = usage.output_tokens;
          if (usage.cache_read_input_tokens)
            metadata.cacheReadTokens = usage.cache_read_input_tokens;
          if (usage.cache_creation_input_tokens)
            metadata.cacheCreationTokens = usage.cache_creation_input_tokens;
        }

        const toolUseNames = extractToolUseNames(msg?.content);
        if (toolUseNames.length > 0) metadata.toolUses = toolUseNames;
        if (toolUseBlocks.length > 0) metadata.toolUseBlocks = toolUseBlocks;

        if (entry.teamName) {
          metadata.teamName = entry.teamName as string;
          if (!teamInfoMap.has(metadata.teamName) && content) {
            const info = parseTeammateMessageTag(content);
            if (info) teamInfoMap.set(metadata.teamName, info);
          }
        }

        let thinkingContent: string | undefined;
        if (type === "assistant") {
          thinkingContent = extractThinkingContent(msg?.content) || undefined;
        }

        const hasMetadata = Object.keys(metadata).length > 0;

        messages.push({
          role: type as MessageSender,
          text: content || "",
          timestamp: (entry.timestamp as string) || "",
          uuid: (entry.uuid as string) || undefined,
          metadata: hasMetadata ? metadata : undefined,
          isToolResult: isToolResultOnly || undefined,
          isThinking: thinkingContent ? true : undefined,
          thinkingContent,
        });
        if (content) textParts.push(content);
      }
    }
  } catch {
    return null;
  }

  if (messages.length === 0) return null;

  // Apply collected team info to matching messages
  if (teamInfoMap.size > 0) {
    for (const msg of messages) {
      if (msg.metadata?.teamName) {
        const info = teamInfoMap.get(msg.metadata.teamName);
        if (info) msg.metadata.teamInfo = info;
      }
    }
  }

  return {
    id: filePath,
    filePath,
    projectPath: cwd,
    projectName: getShortProjectName(cwd),
    sessionId: sessionId || basename(filePath, ".jsonl"),
    sessionName,
    messages,
    fullText: textParts.join(" "),
    timestamp: latestTimestamp || new Date().toISOString(),
    messageCount: messages.length,
    account,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractTextContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return cleanSystemTags(content);
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text" && item?.text) return item.text;
        if (item?.type === "tool_result" && typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .map(cleanSystemTags)
      .join(" ");
  }
  return "";
}

function extractToolUseNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item) => item?.type === "tool_use" && item?.name)
    .map((item) => item.name as string);
}

function extractToolUseBlocks(content: unknown): ToolUseBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item) => item?.type === "tool_use" && item?.name && item?.id)
    .map((item) => ({
      id: item.id as string,
      name: item.name as string,
      input: (item.input as Record<string, unknown>) || {},
    }));
}

function collectToolNames(content: unknown, toolSet: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (item?.type === "tool_use" && item?.name) {
      toolSet.add(item.name as string);
    }
  }
}

function isOnlyToolResultContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.length > 0 && content.every((item) => item?.type === "tool_result");
}

function isTeammateContent(content: unknown): boolean {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((item) =>
              typeof item === "string" ? item : item?.type === "text" ? (item.text ?? "") : "",
            )
            .join("")
        : "";
  return raw.includes("<teammate-message");
}

function extractThinkingContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "thinking" && item?.thinking)
    .map((item) => item.thinking as string)
    .join("\n\n");
}

function parseTeammateMessageTag(content: string): TeamInfo | null {
  const match = content.match(/<teammate-message\s+([^>]*)>/);
  if (!match) return null;
  const attrs = match[1];
  const id = attrs.match(/teammate_id="([^"]*)"/)?.[1];
  if (!id) return null;
  const summary = attrs.match(/summary="([^"]*)"/)?.[1];
  const color = attrs.match(/color="([^"]*)"/)?.[1];
  return { teammateId: id, summary, color };
}

function getShortProjectName(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}
