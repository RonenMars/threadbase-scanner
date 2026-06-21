import fg from "fast-glob";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { basename } from "path";
import { createInterface } from "readline";
import { getLogger } from "../logger";
import { cleanSystemTags } from "../tags";
import type {
  ContentTier,
  Conversation,
  ConversationMessage,
  ConversationMeta,
  MessageSender,
  MessageSnapshot,
} from "../types";
import {
  CODEX_CLI_PROVIDER,
  type DiscoveredConversationFile,
  type ScannerProvider,
} from "./provider";

// Serializable fold state for a Codex CLI rollout session. Plain JSON so a
// future persistent engine can resume it from a byte offset (same contract as
// the Threadbase ReducerState).
export interface CodexAccumulator {
  sessionId: string;
  cwd: string;
  gitBranch: string | null;
  model: string | null;
  latestTimestamp: string;
  messageCount: number;
  lastMessageSender: MessageSender;
  firstUser: MessageSnapshot | null;
  lastUser: MessageSnapshot | null;
  lastAssistant: MessageSnapshot | null;
  toolNames: string[];
  previewParts: string[];
  previewLength: number;
  snippetParts: string[];
  snippetLength: number;
}

// Codex CLI rollout sessions live as rollout-*.jsonl under a date-partitioned
// tree. The Codex provider is opt-in: the scanner only discovers under roots the
// caller passes explicitly (no default home scan).
export class CodexCliProvider implements ScannerProvider<CodexAccumulator> {
  readonly name = CODEX_CLI_PROVIDER;

  async discover(roots: string[]): Promise<DiscoveredConversationFile[]> {
    const log = getLogger();
    const results: DiscoveredConversationFile[] = [];
    for (const root of roots) {
      let paths: string[];
      try {
        paths = await fg(["**/rollout-*.jsonl", "**/*.jsonl"], {
          cwd: root,
          absolute: true,
          dot: false,
          unique: true,
        });
      } catch (err) {
        log.warn({ root, err }, "codex discovery: glob failed");
        continue;
      }
      for (const filePath of paths) {
        try {
          const s = await stat(filePath);
          if (s.size > 0) results.push({ filePath, account: "codex" });
        } catch (err) {
          log.warn({ filePath, err }, "codex discovery: stat failed");
        }
      }
    }
    return results;
  }

  // Codex rollout lines carry distinctive top-level types.
  canParse(_filePath: string, sample: string): boolean {
    for (const line of sample.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (e.type === "session_meta" || e.type === "response_item" || e.type === "event_msg") {
          return true;
        }
        if (e.type === "user" || e.type === "assistant") return false;
      } catch {}
    }
    return false;
  }

  createEmptyAccumulator(): CodexAccumulator {
    return {
      sessionId: "",
      cwd: "",
      gitBranch: null,
      model: null,
      latestTimestamp: "",
      messageCount: 0,
      lastMessageSender: "user",
      firstUser: null,
      lastUser: null,
      lastAssistant: null,
      toolNames: [],
      previewParts: [],
      previewLength: 0,
      snippetParts: [],
      snippetLength: 0,
    };
  }

  reduceEntry(acc: CodexAccumulator, entry: Record<string, unknown>, tier: ContentTier): void {
    reduceCodexEntry(acc, entry, tier);
  }

  finalize(
    acc: CodexAccumulator,
    filePath: string,
    account: string,
    tier: ContentTier,
  ): ConversationMeta | null {
    return finalizeCodexMeta(acc, filePath, account, tier);
  }
}

// ─── Reducer (exported for tests / future incremental engine) ───────────

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

// Pull display text out of a Codex content array of {type,text} blocks.
function extractCodexText(content: unknown): string {
  if (typeof content === "string") return cleanSystemTags(content);
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      const t = item?.type;
      if ((t === "input_text" || t === "output_text" || t === "text") && item?.text) {
        return item.text as string;
      }
      return "";
    })
    .filter(Boolean)
    .map(cleanSystemTags)
    .join(" ");
}

// Fold one Codex rollout line into the accumulator. Tolerant by construction:
// any line it doesn't recognise is ignored, never thrown on.
export function reduceCodexEntry(
  acc: CodexAccumulator,
  entry: Record<string, unknown>,
  tier: ContentTier,
): void {
  const ts = asString(entry.timestamp);
  if (ts && (!acc.latestTimestamp || ts > acc.latestTimestamp)) acc.latestTimestamp = ts;

  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return;

  const type = entry.type as string;

  if (type === "session_meta") {
    if (!acc.sessionId) acc.sessionId = asString(payload.id);
    if (!acc.cwd) acc.cwd = asString(payload.cwd);
    const git = payload.git as Record<string, unknown> | undefined;
    if (acc.gitBranch === null && git?.branch) acc.gitBranch = asString(git.branch) || null;
    return;
  }

  // Model lives on turn_context records (and occasionally elsewhere).
  if (acc.model === null && payload.model) acc.model = asString(payload.model) || null;

  if (type !== "response_item") return;

  const ptype = payload.type as string;

  // Tool calls — collect the tool name.
  if (ptype === "function_call" || ptype === "custom_tool_call") {
    const name = asString(payload.name);
    if (name && !acc.toolNames.includes(name)) acc.toolNames.push(name);
    return;
  }

  if (ptype !== "message") return;

  const role = payload.role;
  // developer/system/tool roles carry sandbox boilerplate — not user-visible turns.
  if (role !== "user" && role !== "assistant") return;

  const text = extractCodexText(payload.content);
  if (!text) return;

  const sender = role as MessageSender;
  acc.messageCount++;
  acc.lastMessageSender = sender;

  const snapshot: MessageSnapshot = { text: text.slice(0, 200), timestamp: ts };
  if (sender === "user") {
    if (!acc.firstUser) acc.firstUser = snapshot;
    acc.lastUser = snapshot;
  } else {
    acc.lastAssistant = snapshot;
  }

  if (acc.previewLength < tier.previewMax) {
    acc.previewParts.push(text);
    acc.previewLength += text.length;
  }
  if (acc.snippetLength < tier.snippetMax) {
    const remaining = tier.snippetMax - acc.snippetLength;
    const chunk = text.length > remaining ? text.slice(0, remaining) : text;
    acc.snippetParts.push(chunk);
    acc.snippetLength += chunk.length;
  }
}

export function finalizeCodexMeta(
  acc: CodexAccumulator,
  filePath: string,
  account: string,
  tier: ContentTier,
): ConversationMeta | null {
  if (acc.messageCount === 0) return null;

  const sessionId = acc.sessionId || basename(filePath, ".jsonl");
  const projectPath = acc.cwd;
  // Treat a session with tool calls but no plain back-and-forth as task-shaped.
  const kind: "conversation" | "task" =
    acc.lastAssistant === null && acc.toolNames.length > 0 ? "task" : "conversation";

  return {
    id: filePath,
    filePath,
    provider: CODEX_CLI_PROVIDER,
    kind,
    externalSessionId: acc.sessionId || undefined,
    sessionId,
    sessionName: "",
    projectPath,
    projectName: getShortProjectName(projectPath),
    account,
    timestamp: acc.latestTimestamp || new Date().toISOString(),
    messageCount: acc.messageCount,
    lastMessageSender: acc.lastMessageSender,
    preview: acc.previewParts.join(" ").slice(0, tier.previewMax),
    contentSnippet: acc.snippetParts.join(" "),
    gitBranch: acc.gitBranch,
    model: acc.model,
    isSubagent: false,
    parentSessionId: null,
    isTeammate: false,
    teamName: null,
    toolNames: acc.toolNames,
    firstMessage: acc.firstUser,
    lastMessage: acc.lastAssistant ?? acc.lastUser,
    lastPrompt: acc.lastUser?.text || undefined,
  };
}

function getShortProjectName(fullPath: string): string {
  return fullPath.split("/").filter(Boolean).slice(-3).join("/");
}

// Full conversation parse for a Codex rollout session — the Codex analogue of
// parseConversation(). Streams the file, emitting one ConversationMessage per
// user/assistant message item. Used by getConversation()/getConversationPage()
// when the resolved meta is a codex-cli conversation.
export async function parseCodexConversation(
  filePath: string,
  account: string,
): Promise<Conversation | null> {
  const log = getLogger();
  const messages: ConversationMessage[] = [];
  const textParts: string[] = [];
  let sessionId = "";
  let cwd = "";
  let latestTimestamp = "";
  let lastUserText = "";

  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = asString(entry.timestamp);
      if (ts && (!latestTimestamp || ts > latestTimestamp)) latestTimestamp = ts;
      const payload = entry.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== "object") continue;

      if (entry.type === "session_meta") {
        if (!sessionId) sessionId = asString(payload.id);
        if (!cwd) cwd = asString(payload.cwd);
        continue;
      }
      if (entry.type !== "response_item" || payload.type !== "message") continue;
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = extractCodexText(payload.content);
      if (!text) continue;
      messages.push({ role: role as MessageSender, text, timestamp: ts });
      textParts.push(text);
      if (role === "user") lastUserText = text;
    }
  } catch (err) {
    log.warn({ filePath, err }, "parseCodexConversation: read failed");
    return null;
  }

  if (messages.length === 0) return null;

  return {
    id: filePath,
    filePath,
    projectPath: cwd,
    projectName: getShortProjectName(cwd),
    sessionId: sessionId || basename(filePath, ".jsonl"),
    sessionName: "",
    messages,
    fullText: textParts.join(" "),
    timestamp: latestTimestamp || new Date().toISOString(),
    messageCount: messages.length,
    account,
    lastPrompt: lastUserText || undefined,
  };
}
