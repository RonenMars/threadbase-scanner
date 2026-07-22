import { createReadStream } from "fs";
import { basename } from "path";
import { createInterface } from "readline";
import { getLogger } from "./logger";
import { applyTeamInfo, initialConvState, reduceConvLine } from "./persistent/conversation-reducer";
import {
  deriveSessionNameFromFirstMessage,
  finalizeMeta,
  initialReducerState,
  reduceLine,
} from "./persistent/metadata-reducer";
import { cleanSystemTags } from "./tags";
import type {
  ContentTier,
  Conversation,
  ConversationMessage,
  ConversationMeta,
  TeamInfo,
  ToolResultBlock,
  ToolUseBlock,
  TurnDuration,
} from "./types";

export async function parseMeta(
  filePath: string,
  account: string,
  tier: ContentTier,
): Promise<ConversationMeta | null> {
  const log = getLogger();
  log.trace({ filePath, account, tier: tier.name }, "parseMeta: start");

  // Stream the whole file through the same per-line fold the incremental
  // indexer uses, so a full parse and an append-then-resume produce identical
  // metadata by construction.
  const state = initialReducerState();
  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        state.badJsonLines++;
        continue;
      }
      reduceLine(state, entry, tier);
    }
  } catch (err) {
    log.warn({ filePath, err }, "parseMeta: read failed");
    return null;
  }

  if (state.badJsonLines > 0) {
    log.warn(
      { filePath, badJsonLines: state.badJsonLines },
      "parseMeta: skipped malformed JSON lines",
    );
  }

  const meta = finalizeMeta(state, filePath, account, tier);
  if (!meta) log.trace({ filePath }, "parseMeta: no messages");
  return meta;
}

export async function parseConversation(
  filePath: string,
  account: string,
): Promise<Conversation | null> {
  const log = getLogger();
  log.trace({ filePath, account }, "parseConversation: start");
  const messages: ConversationMessage[] = [];
  let badJsonLines = 0;
  const textParts: string[] = [];
  const turnDurations: TurnDuration[] = [];

  // The message line→message reduction lives in reduceConvLine (shared with the
  // bounded page reader). turn_duration collection is parseConversation-only
  // (pages don't need it), so it stays inline here.
  const state = initialConvState();

  const fileStream = createReadStream(filePath);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        badJsonLines++;
        continue;
      }

      if (
        entry.type === "system" &&
        entry.subtype === "turn_duration" &&
        typeof entry.durationMs === "number"
      ) {
        turnDurations.push({
          durationMs: entry.durationMs as number,
          messageCount: (entry.messageCount as number) || 0,
          uuid: entry.uuid as string | undefined,
        });
        continue;
      }

      const message = reduceConvLine(state, entry);
      if (message) {
        messages.push(message);
        if (message.text) textParts.push(message.text);
      }
    }
  } catch (err) {
    log.warn({ filePath, err }, "parseConversation: read failed");
    return null;
  }

  if (badJsonLines > 0) {
    log.warn({ filePath, badJsonLines }, "parseConversation: skipped malformed JSON lines");
  }

  if (messages.length === 0) {
    log.trace({ filePath }, "parseConversation: no messages");
    return null;
  }

  log.debug({ filePath, messageCount: messages.length }, "parseConversation: complete");
  applyTeamInfo(messages, state);

  return {
    id: filePath,
    filePath,
    projectPath: state.cwd,
    projectName: getShortProjectName(state.cwd),
    sessionId: state.sessionId || basename(filePath, ".jsonl"),
    sessionName:
      state.sessionName ||
      deriveSessionNameFromFirstMessage(messages.find((m) => m.role === "user" && m.text) ?? null),
    messages,
    fullText: textParts.join(" "),
    timestamp: state.latestTimestamp || new Date().toISOString(),
    messageCount: messages.length,
    account,
    turnDurations: turnDurations.length > 0 ? turnDurations : undefined,
    lastPrompt: state.lastPrompt || undefined,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function extractTextContent(content: unknown): string {
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

export function extractToolUseNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item) => item?.type === "tool_use" && item?.name)
    .map((item) => item.name as string);
}

export function extractToolUseBlocks(content: unknown): ToolUseBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item) => item?.type === "tool_use" && item?.name && item?.id)
    .map((item) => ({
      id: item.id as string,
      name: item.name as string,
      input: (item.input as Record<string, unknown>) || {},
    }));
}

const TOOL_NAME_TO_TYPE: Record<string, ToolResultBlock["type"]> = {
  Edit: "edit",
  Write: "write",
  Read: "read",
  Bash: "bash",
  Grep: "grep",
  Glob: "glob",
  Agent: "taskAgent",
  TaskCreate: "taskCreate",
  TaskUpdate: "taskUpdate",
};

export function extractToolResultBlocks(
  content: unknown,
  pendingToolUses: Map<string, ToolUseBlock>,
): ToolResultBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((item) => item?.type === "tool_result" && item?.tool_use_id)
    .map((item) => {
      const toolName = pendingToolUses.get(item.tool_use_id as string)?.name ?? "";
      return {
        toolUseId: item.tool_use_id as string,
        type: TOOL_NAME_TO_TYPE[toolName] ?? "generic",
        content:
          typeof item.content === "string"
            ? { text: item.content as string }
            : ((item.content as Record<string, unknown>) ?? {}),
        isError: typeof item.is_error === "boolean" ? item.is_error : undefined,
      };
    });
}

export function collectToolNames(content: unknown, toolSet: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (item?.type === "tool_use" && item?.name) {
      toolSet.add(item.name as string);
    }
  }
}

export function isOnlyToolResultContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.length > 0 && content.every((item) => item?.type === "tool_result");
}

export function isTeammateContent(content: unknown): boolean {
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

export function extractThinking(content: unknown): { content: string; signature: string } {
  if (!Array.isArray(content)) return { content: "", signature: "" };
  const blocks = content.filter((item) => item?.type === "thinking");
  return {
    content: blocks
      .map((b) => b.thinking as string)
      .filter(Boolean)
      .join("\n\n"),
    signature: blocks
      .map((b) => b.signature as string)
      .filter(Boolean)
      .join(""),
  };
}

export function hasImageBlocks(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (item) =>
      item?.type === "image" &&
      (item?.source?.type === "base64" || item?.file?.base64 !== undefined),
  );
}

export function parseTeammateMessageTag(content: string): TeamInfo | null {
  const match = content.match(/<teammate-message\s+([^>]*)>/);
  if (!match) return null;
  const attrs = match[1];
  const id = attrs.match(/teammate_id="([^"]*)"/)?.[1];
  if (!id) return null;
  const summary = attrs.match(/summary="([^"]*)"/)?.[1];
  const color = attrs.match(/color="([^"]*)"/)?.[1];
  return { teammateId: id, summary, color };
}

export function getShortProjectName(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}
