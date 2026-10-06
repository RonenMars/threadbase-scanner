import fg from "fast-glob";
import { createReadStream, statSync } from "fs";
import { stat } from "fs/promises";
import { basename, dirname } from "path";
import { createInterface } from "readline";
import { canonicalPath } from "../canonical-path";
import { getLogger } from "../logger";
import { deriveSessionNameFromFirstMessage } from "../persistent/metadata-reducer";
import { cleanSystemTags } from "../tags";
import type {
  ContentTier,
  Conversation,
  ConversationMessage,
  ConversationMeta,
  MessageSender,
  MessageSnapshot,
  ToolUseBlock,
} from "../types";
import {
  COPILOT_PROVIDER,
  type DiscoveredConversationFile,
  type ScannerProvider,
} from "./provider";

// GitHub Copilot CLI keeps one directory per session,
// `<COPILOT_HOME or ~/.copilot>/session-state/<sessionId>/events.jsonl`.
// Every line is `{ type, data, id, timestamp, parentId }` (verified on Copilot
// CLI 1.0.81 through 1.0.92).
//
// Only three event types are read:
//   session.start      data.sessionId, data.context.cwd, data.context.branch
//   user.message       data.content — the prompt as typed. data.transformedContent
//                      is the same prompt wrapped in <current_datetime> /
//                      <system_reminder> blocks for the model, so it is not used.
//   assistant.message  data.content, data.toolRequests[], data.model
//
// Everything else is ignored, and for `model.*` that is load-bearing:
// model.message / model.response / model.messages_snapshot carry `role` and
// `content` too, but they record side-channel calls to small utility models
// (routing, classification), never the reply the user saw. Indexing them would
// add text to the conversation that was never in it.
export interface CopilotAccumulator {
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

const SESSION_START = "session.start";
const USER_MESSAGE = "user.message";
const ASSISTANT_MESSAGE = "assistant.message";

export class CopilotProvider implements ScannerProvider<CopilotAccumulator> {
  readonly name = COPILOT_PROVIDER;

  async discover(roots: string[]): Promise<DiscoveredConversationFile[]> {
    const log = getLogger();
    const results: DiscoveredConversationFile[] = [];
    for (const root of roots) {
      let paths: string[];
      try {
        // Accept either the session-state directory or the Copilot home above
        // it. session-store.db (a listing subset of the same sessions) is not
        // read, so a session is never counted twice.
        paths = await fg(["*/events.jsonl", "session-state/*/events.jsonl"], {
          cwd: root,
          absolute: true,
          dot: false,
          unique: true,
        });
      } catch (err) {
        log.warn({ root, err }, "copilot discovery: glob failed");
        continue;
      }
      for (const filePath of paths) {
        try {
          const s = await stat(filePath);
          if (s.size > 0) results.push({ filePath: canonicalPath(filePath), account: "copilot" });
        } catch (err) {
          log.warn({ filePath, err }, "copilot discovery: stat failed");
        }
      }
    }
    return results;
  }

  canParse(_filePath: string, sample: string): boolean {
    for (const line of sample.split("\n")) {
      if (!line.trim()) continue;
      try {
        if (looksLikeCopilotEvent(JSON.parse(line) as Record<string, unknown>)) return true;
      } catch {}
    }
    return false;
  }

  createEmptyAccumulator(): CopilotAccumulator {
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

  reduceEntry(acc: CopilotAccumulator, entry: Record<string, unknown>, tier: ContentTier): void {
    reduceCopilotEntry(acc, entry, tier);
  }

  finalize(
    acc: CopilotAccumulator,
    filePath: string,
    account: string,
    tier: ContentTier,
  ): ConversationMeta | null {
    return finalizeCopilotMeta(acc, filePath, account, tier);
  }
}

// The envelope, not a type list: Claude lines have no `data`/`parentId` (they
// use `parentUuid`), Codex lines carry `payload`, Cursor lines have no `type`.
export function looksLikeCopilotEvent(entry: Record<string, unknown>): boolean {
  return (
    typeof entry.type === "string" &&
    typeof entry.id === "string" &&
    "parentId" in entry &&
    asRecord(entry.data) !== null
  );
}

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// `arguments` is an object for most tool requests and a raw string for a few.
function copilotToolUseBlocks(data: Record<string, unknown>): ToolUseBlock[] {
  if (!Array.isArray(data.toolRequests)) return [];
  const blocks: ToolUseBlock[] = [];
  for (const item of data.toolRequests) {
    const request = asRecord(item);
    const name = asString(request?.name);
    if (!request || !name) continue;
    const input = asRecord(request.arguments) ?? { arguments: asString(request.arguments) };
    blocks.push({ id: asString(request.toolCallId), name, input });
  }
  return blocks;
}

function copilotEntryToMessage(entry: Record<string, unknown>): ConversationMessage | null {
  if (!looksLikeCopilotEvent(entry)) return null;
  const data = entry.data as Record<string, unknown>;
  const timestamp = asString(entry.timestamp);
  const uuid = asString(data.messageId) || asString(entry.id);

  if (entry.type === USER_MESSAGE) {
    const text = cleanSystemTags(asString(data.content));
    return text ? { role: "user", text, timestamp, uuid } : null;
  }
  if (entry.type === ASSISTANT_MESSAGE) {
    const text = asString(data.content).trim();
    const blocks = copilotToolUseBlocks(data);
    // A tool-calling step has empty content; it still renders as its tool calls.
    if (!text && blocks.length === 0) return null;
    const model = asString(data.model);
    const metadata = {
      ...(model ? { model } : {}),
      ...(blocks.length > 0 ? { toolUses: blocks.map((b) => b.name), toolUseBlocks: blocks } : {}),
    };
    return {
      role: "assistant",
      text,
      timestamp,
      uuid,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }
  return null;
}

// Stateless line → message mapping, for a host tailing appended lines. Returns
// null for every event that is not a user prompt or an assistant message.
export function parseCopilotJsonlLine(line: string): ConversationMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return copilotEntryToMessage(JSON.parse(trimmed) as Record<string, unknown>);
  } catch {
    return null;
  }
}

// session.start is the only event that names the session and its directory.
function readSessionStart(
  entry: Record<string, unknown>,
): { sessionId: string; cwd: string; branch: string } | null {
  if (entry.type !== SESSION_START) return null;
  const data = asRecord(entry.data);
  if (!data) return null;
  const context = asRecord(data.context);
  return {
    sessionId: asString(data.sessionId),
    cwd: asString(context?.cwd),
    branch: asString(context?.branch),
  };
}

export function reduceCopilotEntry(
  acc: CopilotAccumulator,
  entry: Record<string, unknown>,
  tier: ContentTier,
): void {
  const start = readSessionStart(entry);
  if (start) {
    if (!acc.sessionId) acc.sessionId = start.sessionId;
    if (!acc.cwd) acc.cwd = start.cwd;
    if (!acc.gitBranch && start.branch) acc.gitBranch = start.branch;
    return;
  }

  const message = copilotEntryToMessage(entry);
  if (!message) return;

  for (const name of message.metadata?.toolUses ?? []) {
    if (!acc.toolNames.includes(name)) acc.toolNames.push(name);
  }
  if (message.metadata?.model) acc.model = message.metadata.model;
  // Tool-only steps are not counted as messages, matching the other providers.
  const { role, text, timestamp } = message;
  if (!text) return;

  if (timestamp && (!acc.latestTimestamp || timestamp > acc.latestTimestamp)) {
    acc.latestTimestamp = timestamp;
  }
  acc.messageCount++;
  acc.lastMessageSender = role;
  const snapshot: MessageSnapshot = { text: text.slice(0, 200), timestamp };
  if (role === "user") {
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

export function finalizeCopilotMeta(
  acc: CopilotAccumulator,
  filePath: string,
  account: string,
  tier: ContentTier,
): ConversationMeta | null {
  if (acc.messageCount === 0) return null;

  const sessionId = acc.sessionId || sessionIdFromPath(filePath);
  const kind: "conversation" | "task" =
    acc.lastAssistant === null && acc.toolNames.length > 0 ? "task" : "conversation";

  return {
    id: filePath,
    filePath,
    provider: COPILOT_PROVIDER,
    kind,
    externalSessionId: sessionId,
    sessionId,
    sessionName: deriveSessionNameFromFirstMessage(acc.firstUser),
    projectPath: acc.cwd,
    projectName: getShortProjectName(acc.cwd),
    account,
    timestamp: acc.latestTimestamp || fileMtimeIso(filePath),
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

// The session directory is named for the session id, which covers a file whose
// session.start line is missing or unreadable.
function sessionIdFromPath(filePath: string): string {
  return basename(dirname(filePath));
}

function getShortProjectName(fullPath: string): string {
  return fullPath.split(/[/\\]/).filter(Boolean).slice(-3).join("/");
}

function fileMtimeIso(filePath: string): string {
  try {
    return new Date(statSync(filePath).mtimeMs).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

export async function parseCopilotConversation(
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
      const start = readSessionStart(entry);
      if (start) {
        if (!sessionId) sessionId = start.sessionId;
        if (!cwd) cwd = start.cwd;
        continue;
      }
      const message = copilotEntryToMessage(entry);
      if (!message) continue;
      if (message.timestamp && (!latestTimestamp || message.timestamp > latestTimestamp)) {
        latestTimestamp = message.timestamp;
      }
      messages.push(message);
      // Tool-only messages carry no text; they must not blank lastPrompt.
      if (!message.text) continue;
      textParts.push(message.text);
      if (message.role === "user") lastUserText = message.text;
    }
  } catch (err) {
    log.warn({ filePath, err }, "parseCopilotConversation: read failed");
    return null;
  }

  if (messages.length === 0) return null;

  return {
    id: filePath,
    filePath,
    projectPath: cwd,
    projectName: getShortProjectName(cwd),
    sessionId: sessionId || sessionIdFromPath(filePath),
    sessionName: "",
    messages,
    fullText: textParts.join(" "),
    timestamp: latestTimestamp || fileMtimeIso(filePath),
    messageCount: messages.length,
    account,
    lastPrompt: lastUserText || undefined,
  };
}
