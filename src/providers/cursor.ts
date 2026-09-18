import { createHash } from "crypto";
import fg from "fast-glob";
import { createReadStream, existsSync, statSync } from "fs";
import { stat } from "fs/promises";
import { basename, dirname, join, sep } from "path";
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
import { parseCodexJsonlLine } from "./codex-cli";
import { CURSOR_PROVIDER, type DiscoveredConversationFile, type ScannerProvider } from "./provider";

// Cursor agent-transcripts JSONL: `{ role, message: { content: [{ type, text }] } }`.
// No envelope `type` of user/assistant (that's Claude), no session_meta (that's
// Codex), and no per-line timestamp — user turns wrap the clock in <timestamp>.
export interface CursorAccumulator {
  sessionId: string;
  latestTimestamp: string;
  messageCount: number;
  lastMessageSender: MessageSender;
  isSubagent: boolean;
  parentSessionUuid: string | null;
  subagentId: string | null;
  firstUser: MessageSnapshot | null;
  lastUser: MessageSnapshot | null;
  lastAssistant: MessageSnapshot | null;
  isImportedFromClaude: boolean;
  isImportedFromCodex: boolean;
  toolNames: string[];
  previewParts: string[];
  previewLength: number;
  snippetParts: string[];
  snippetLength: number;
}

const TIMESTAMP_RE = /<timestamp>\s*([\s\S]*?)\s*<\/timestamp>/;
const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
const SUBAGENT_PATH_RE = /[\\/]subagents[\\/]/;

export class CursorProvider implements ScannerProvider<CursorAccumulator> {
  readonly name = CURSOR_PROVIDER;

  async discover(roots: string[]): Promise<DiscoveredConversationFile[]> {
    const log = getLogger();
    const results: DiscoveredConversationFile[] = [];
    for (const root of roots) {
      let paths: string[];
      try {
        // Composer chat lives in state.vscdb — not these files. Only the JSONL
        // agent-transcripts tree is in scope (feasibility Phase 1, not Phase 3).
        paths = await fg(["**/agent-transcripts/**/*.jsonl"], {
          cwd: root,
          absolute: true,
          dot: false,
          unique: true,
        });
      } catch (err) {
        log.warn({ root, err }, "cursor discovery: glob failed");
        continue;
      }
      for (const filePath of paths) {
        try {
          const s = await stat(filePath);
          if (s.size > 0) results.push({ filePath: canonicalPath(filePath), account: "cursor" });
        } catch (err) {
          log.warn({ filePath, err }, "cursor discovery: stat failed");
        }
      }
    }
    return results;
  }

  canParse(filePath: string, sample: string): boolean {
    const underTranscripts = /[\\/]agent-transcripts[\\/]/.test(filePath);
    for (const line of sample.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        // Native Claude/Codex files stay with those providers. Copies that land
        // under agent-transcripts are Cursor imports — claim them here so they
        // are not skipped, and fold the envelopes in reduceEntry.
        if (looksLikeImportedCodexEntry(e) || looksLikeImportedClaudeEntry(e)) {
          return underTranscripts;
        }
        if (looksLikeCursorChatEntry(e)) return true;
      } catch {}
    }
    return false;
  }

  createEmptyAccumulator(): CursorAccumulator {
    return {
      sessionId: "",
      latestTimestamp: "",
      messageCount: 0,
      lastMessageSender: "user",
      isSubagent: false,
      parentSessionUuid: null,
      subagentId: null,
      firstUser: null,
      lastUser: null,
      lastAssistant: null,
      isImportedFromClaude: false,
      isImportedFromCodex: false,
      toolNames: [],
      previewParts: [],
      previewLength: 0,
      snippetParts: [],
      snippetLength: 0,
    };
  }

  reduceEntry(acc: CursorAccumulator, entry: Record<string, unknown>, tier: ContentTier): void {
    reduceCursorEntry(acc, entry, tier);
  }

  finalize(
    acc: CursorAccumulator,
    filePath: string,
    account: string,
    tier: ContentTier,
  ): ConversationMeta | null {
    return finalizeCursorMeta(acc, filePath, account, tier);
  }
}

export function looksLikeCursorChatEntry(entry: Record<string, unknown>): boolean {
  const role = entry.role;
  if (role !== "user" && role !== "assistant") return false;
  // Claude's envelope uses top-level type user/assistant. Cursor does not.
  if (entry.type === "user" || entry.type === "assistant") return false;
  return true;
}

function looksLikeImportedClaudeEntry(entry: Record<string, unknown>): boolean {
  return entry.type === "user" || entry.type === "assistant";
}

function looksLikeImportedCodexEntry(entry: Record<string, unknown>): boolean {
  return (
    entry.type === "session_meta" || entry.type === "response_item" || entry.type === "event_msg"
  );
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function provenanceToken(value: unknown): string {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return provenanceToken(
      rec.importedFrom ?? rec.imported_from ?? rec.sourceProvider ?? rec.source,
    );
  }
  return "";
}

function importedFromClaudeToken(token: string): boolean {
  return (
    token === "claude" ||
    token === "claude-code" ||
    token === "claude_code" ||
    token === "anthropic"
  );
}

function importedFromCodexToken(token: string): boolean {
  return (
    token === "codex" || token === "codex-cli" || token === "codex_cli" || token === "openai-codex"
  );
}

function noteImportProvenance(
  acc: CursorAccumulator,
  entry: Record<string, unknown>,
  text: string,
): void {
  const token = provenanceToken(
    entry.importedFrom ??
      entry.imported_from ??
      entry.sourceProvider ??
      entry.source ??
      (entry.message && typeof entry.message === "object"
        ? ((entry.message as Record<string, unknown>).importedFrom ??
          (entry.message as Record<string, unknown>).imported_from ??
          (entry.message as Record<string, unknown>).sourceProvider)
        : undefined),
  );
  if (importedFromClaudeToken(token) || looksLikeImportedClaudeEntry(entry)) {
    acc.isImportedFromClaude = true;
  }
  if (importedFromCodexToken(token) || looksLikeImportedCodexEntry(entry)) {
    acc.isImportedFromCodex = true;
  }
  if (/imported from claude/i.test(text) || /<imported_from_claude>/i.test(text)) {
    acc.isImportedFromClaude = true;
  }
  if (/imported from codex/i.test(text) || /<imported_from_codex>/i.test(text)) {
    acc.isImportedFromCodex = true;
  }
}

export function unwrapCursorUserText(text: string): string {
  const query = text.match(USER_QUERY_RE);
  const body = query ? query[1] : text.replace(TIMESTAMP_RE, "");
  return cleanSystemTags(body);
}

export function timestampFromCursorUserText(text: string): string {
  const match = text.match(TIMESTAMP_RE);
  if (!match) return "";
  const parsed = Date.parse(match[1].trim());
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
}

function extractCursorText(content: unknown): string {
  if (typeof content === "string") return unwrapCursorUserText(content);
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return unwrapCursorUserText(item);
      const block = item as { type?: string; text?: string };
      if ((block?.type === "text" || block?.type === undefined) && typeof block.text === "string") {
        return unwrapCursorUserText(block.text);
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function collectCursorToolNames(content: unknown, into: string[]): void {
  if (!Array.isArray(content)) return;
  for (const item of content) {
    const block = item as { type?: string; name?: string };
    if (block?.type === "tool_use" && typeof block.name === "string" && block.name) {
      if (!into.includes(block.name)) into.push(block.name);
    }
  }
}

function firstTimestampHint(content: unknown): string {
  if (typeof content === "string") return timestampFromCursorUserText(content);
  if (!Array.isArray(content)) return "";
  for (const item of content) {
    if (typeof item === "string") {
      const ts = timestampFromCursorUserText(item);
      if (ts) return ts;
    } else if (typeof (item as { text?: string })?.text === "string") {
      const ts = timestampFromCursorUserText((item as { text: string }).text);
      if (ts) return ts;
    }
  }
  return "";
}

export function parseCursorJsonlLine(line: string): ConversationMessage | null {
  if (!line.trim()) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  return cursorEntryToMessage(entry);
}

function cursorEntryToMessage(entry: Record<string, unknown>): ConversationMessage | null {
  if (looksLikeCursorChatEntry(entry)) {
    const role = entry.role as MessageSender;
    const message = entry.message as { content?: unknown } | undefined;
    const content = message?.content ?? entry.content;
    return withToolUses(
      { role, text: extractCursorText(content), timestamp: firstTimestampHint(content) },
      content,
    );
  }
  if (looksLikeImportedClaudeEntry(entry)) {
    const message = entry.message as { content?: unknown; role?: string } | undefined;
    const role = (
      message?.role === "assistant" || entry.type === "assistant" ? "assistant" : "user"
    ) as MessageSender;
    const content = message?.content ?? entry.content;
    return withToolUses(
      { role, text: extractCursorText(content), timestamp: asString(entry.timestamp) },
      content,
    );
  }
  return parseCodexJsonlLine(JSON.stringify(entry));
}

// Attach the line's tool_use blocks, the same metadata the Claude parser fills.
// A message renders when it has text or tool calls; neither → null.
function withToolUses(message: ConversationMessage, content: unknown): ConversationMessage | null {
  const blocks = extractCursorToolUseBlocks(content);
  if (blocks.length === 0) return message.text ? message : null;
  return {
    ...message,
    metadata: { toolUses: blocks.map((b) => b.name), toolUseBlocks: blocks },
  };
}

// Cursor's tool_use blocks carry no id, and ToolUseBlock needs one, so derive a
// stable one from the call itself: re-reading the same line yields the same id.
function extractCursorToolUseBlocks(content: unknown): ToolUseBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ToolUseBlock[] = [];
  for (const item of content) {
    const block = item as { type?: string; id?: string; name?: string; input?: unknown };
    if (block?.type !== "tool_use" || typeof block.name !== "string" || !block.name) continue;
    const input =
      block.input && typeof block.input === "object" && !Array.isArray(block.input)
        ? (block.input as Record<string, unknown>)
        : {};
    const id =
      typeof block.id === "string" && block.id
        ? block.id
        : `cursor-tool-${createHash("sha1")
            .update(`${block.name}\0${JSON.stringify(input)}`)
            .digest("hex")
            .slice(0, 16)}`;
    blocks.push({ id, name: block.name, input });
  }
  return blocks;
}

function foldCursorMessage(
  acc: CursorAccumulator,
  role: MessageSender,
  text: string,
  timestamp: string,
  tier: ContentTier,
): void {
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

export function reduceCursorEntry(
  acc: CursorAccumulator,
  entry: Record<string, unknown>,
  tier: ContentTier,
): void {
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content ?? entry.content;
  const textHint = extractCursorText(content);
  noteImportProvenance(acc, entry, textHint);

  if (looksLikeCursorChatEntry(entry)) {
    collectCursorToolNames(content, acc.toolNames);
    const text = textHint;
    if (!text) return;
    foldCursorMessage(acc, entry.role as MessageSender, text, firstTimestampHint(content), tier);
    return;
  }

  if (looksLikeImportedClaudeEntry(entry)) {
    collectCursorToolNames(content, acc.toolNames);
    const msg = cursorEntryToMessage(entry);
    if (!msg?.text) return;
    foldCursorMessage(acc, msg.role, msg.text, msg.timestamp, tier);
    return;
  }

  if (looksLikeImportedCodexEntry(entry)) {
    const msg = parseCodexJsonlLine(JSON.stringify(entry));
    if (!msg?.text) return;
    foldCursorMessage(acc, msg.role, msg.text, msg.timestamp, tier);
  }
}

export function finalizeCursorMeta(
  acc: CursorAccumulator,
  filePath: string,
  account: string,
  tier: ContentTier,
): ConversationMeta | null {
  if (acc.messageCount === 0) return null;

  const sessionId = basename(filePath, ".jsonl");
  const isSubagent = SUBAGENT_PATH_RE.test(filePath);
  const parent = isSubagent ? parentFromSubagentPath(filePath) : null;
  const { projectPath, projectName } = projectFromCursorPath(filePath);
  const timestamp = acc.latestTimestamp || fileMtimeIso(filePath);
  const kind: "conversation" | "task" =
    acc.lastAssistant === null && acc.toolNames.length > 0 ? "task" : "conversation";

  return {
    id: filePath,
    filePath,
    provider: CURSOR_PROVIDER,
    kind,
    externalSessionId: sessionId,
    sessionId,
    sessionName: deriveSessionNameFromFirstMessage(acc.firstUser),
    projectPath,
    projectName,
    account,
    timestamp,
    messageCount: acc.messageCount,
    lastMessageSender: acc.lastMessageSender,
    preview: acc.previewParts.join(" ").slice(0, tier.previewMax),
    contentSnippet: acc.snippetParts.join(" "),
    gitBranch: null,
    model: null,
    isSubagent,
    parentSessionId: parent?.parentFilePath ?? null,
    subagentId: isSubagent ? sessionId : undefined,
    parentSessionUuid: parent?.parentSessionUuid ?? undefined,
    isTeammate: false,
    teamName: null,
    toolNames: acc.toolNames,
    firstMessage: acc.firstUser,
    lastMessage: acc.lastAssistant ?? acc.lastUser,
    lastPrompt: acc.lastUser?.text || undefined,
    ...(acc.isImportedFromClaude ? { isImportedFromClaude: true } : {}),
    ...(acc.isImportedFromCodex ? { isImportedFromCodex: true } : {}),
  };
}

function parentFromSubagentPath(
  filePath: string,
): { parentFilePath: string; parentSessionUuid: string } | null {
  const subagentsDir = dirname(filePath);
  const parentDir = dirname(subagentsDir);
  const parentSessionUuid = basename(parentDir);
  if (!parentSessionUuid) return null;
  return {
    parentSessionUuid,
    parentFilePath: canonicalPath(join(parentDir, `${parentSessionUuid}.jsonl`)),
  };
}

// Cursor encodes the workspace as ~/.cursor/projects/<slug>/agent-transcripts/…
// The slug replaces path separators with '-'. That is lossy when a directory
// name already contains hyphens, so we only promote a decoded path when it
// exists on disk; otherwise the Cursor project directory is the identity.
function projectFromCursorPath(filePath: string): { projectPath: string; projectName: string } {
  const parts = filePath.split(/[/\\]/);
  const idx = parts.lastIndexOf("agent-transcripts");
  const cursorProjectDir = idx > 0 ? parts.slice(0, idx).join(sep) : dirname(dirname(filePath));
  const slug = basename(cursorProjectDir);
  const decoded = decodeCursorProjectSlug(slug);
  const projectPath = decoded ?? cursorProjectDir;
  return { projectPath, projectName: getShortProjectName(projectPath) || slug };
}

export function decodeCursorProjectSlug(slug: string): string | null {
  if (!slug) return null;
  const segments = slug.split("-");
  if (segments.length === 0) return null;
  const rooted = slug.startsWith("Users-") || slug.startsWith("home-") || /^[A-Za-z]-/.test(slug);
  let acc = rooted ? sep : "";
  let i = 0;
  if (rooted && segments[0] === "Users") {
    const users = `${sep}Users`;
    if (!existsSync(users)) return null;
    acc = users;
    i = 1;
  }
  while (i < segments.length) {
    let found: string | null = null;
    let next = i + 1;
    for (let j = segments.length; j > i; j--) {
      const candidate = join(acc, segments.slice(i, j).join("-"));
      try {
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
          found = candidate;
          next = j;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (!found) return null;
    acc = found;
    i = next;
  }
  return acc;
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

export async function parseCursorConversation(
  filePath: string,
  account: string,
): Promise<Conversation | null> {
  const log = getLogger();
  const messages: ConversationMessage[] = [];
  const textParts: string[] = [];
  let latestTimestamp = "";
  let lastUserText = "";

  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const message = parseCursorJsonlLine(line);
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
    log.warn({ filePath, err }, "parseCursorConversation: read failed");
    return null;
  }

  if (messages.length === 0) return null;

  const { projectPath, projectName } = projectFromCursorPath(filePath);
  const sessionId = basename(filePath, ".jsonl");
  return {
    id: filePath,
    filePath,
    projectPath,
    projectName,
    sessionId,
    sessionName: "",
    messages,
    fullText: textParts.join(" "),
    timestamp: latestTimestamp || fileMtimeIso(filePath),
    messageCount: messages.length,
    account,
    lastPrompt: lastUserText || undefined,
  };
}
