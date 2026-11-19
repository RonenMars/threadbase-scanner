import { cleanSystemTags } from "./tags";
import type { TeamInfo, ToolResultBlock, ToolUseBlock } from "./types";

// A prompt the user sends while Claude is mid-turn is written only as a
// queued_command attachment, never as a `user` row, so history would drop it.
// Returns the `user` entry it stands for; every other entry, including the
// task-notification and peer queued_commands, comes back unchanged.
export function asQueuedPromptUserEntry(entry: Record<string, unknown>): Record<string, unknown> {
  if (entry.type !== "attachment") return entry;
  const att = entry.attachment as
    | { type?: string; commandMode?: string; origin?: { kind?: string }; prompt?: unknown }
    | undefined;
  if (att?.type !== "queued_command" || att.commandMode !== "prompt") return entry;
  if (att.origin?.kind !== "human") return entry;
  return {
    ...entry,
    type: "user",
    attachment: undefined,
    message: { role: "user", content: att.prompt },
  };
}

// A typed slash command is stored as <command-name>/x</command-name> plus
// <command-args>…</command-args>, and the args are where the user's real prompt
// lives (`/plan <prompt>`). cleanSystemTags strips both tags, which emptied the
// line and dropped the session's first prompt from history. Rebuild what was typed.
const COMMAND_RE = /^\s*<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

function cleanText(text: string): string {
  const name = text.match(COMMAND_RE)?.[1]?.trim();
  const args = name ? text.match(COMMAND_ARGS_RE)?.[1]?.trim() : undefined;
  // A bare command (/compact, /clear) carries no prompt and stays hidden.
  return name && args ? `${name} ${args}` : cleanSystemTags(text);
}

export function extractTextContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return cleanText(content);
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "text" && item?.text) return item.text;
        if (item?.type === "tool_result" && typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .map(cleanText)
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

export function isOnlyToolResultContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.length > 0 && content.every((item) => item?.type === "tool_result");
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
