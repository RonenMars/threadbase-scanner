import { basename } from "path";
import { getShortProjectName } from "../parser";
import type { Conversation, ConversationMessage, TurnDuration } from "../types";
import { applyTeamInfo, type ConvReducerState, initialConvState } from "./conversation-reducer";
import { streamMessages } from "./paged-reader";

// A parsed conversation held in the scanner's LRU together with the resume
// point needed to extend it in place when its file grows: the conversation
// reducer state at EOF plus the byte/line offset just past the last complete
// line. `resume` is absent for providers without a resumable reducer (Codex)
// — a refresh evicts those entries instead of extending them.
export interface ConversationResume {
  state: ConvReducerState;
  offset: number;
  line: number;
}

export interface CachedConversation {
  conversation: Conversation;
  resume?: ConversationResume;
}

// Fold [resume.offset, EOF) through the conversation reducer, collecting the
// produced messages plus turn_duration entries. turn_duration lines are
// consumed BEFORE the reducer — exactly as parseConversation does — so their
// header fields (timestamps) never leak into the conversation state. Mutates
// resume.state in place; on failure the caller must discard the cached entry.
async function foldTail(filePath: string, resume: ConversationResume) {
  const messages: ConversationMessage[] = [];
  const textParts: string[] = [];
  const turnDurations: TurnDuration[] = [];
  const end = await streamMessages(
    filePath,
    resume.offset,
    resume.line,
    resume.state,
    (message) => {
      messages.push(message);
      if (message.text) textParts.push(message.text);
      return false; // never stop early — fold to EOF
    },
    (entry) => {
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
        return true;
      }
      return false;
    },
  );
  return { messages, textParts, turnDurations, end };
}

// Assemble the Conversation shape exactly as parseConversation() does.
function assemble(
  filePath: string,
  account: string,
  messages: ConversationMessage[],
  fullText: string,
  turnDurations: TurnDuration[],
  state: ConvReducerState,
): Conversation {
  return {
    id: filePath,
    filePath,
    projectPath: state.cwd,
    projectName: getShortProjectName(state.cwd),
    sessionId: state.sessionId || basename(filePath, ".jsonl"),
    sessionName: state.sessionName,
    messages,
    fullText,
    timestamp: state.latestTimestamp || new Date().toISOString(),
    messageCount: messages.length,
    account,
    turnDurations: turnDurations.length > 0 ? turnDurations : undefined,
    lastPrompt: state.lastPrompt || undefined,
  };
}

// Full parse that also captures the resume point, so a later append can extend
// the result in place instead of re-parsing the file. Identical to
// parseConversation() by construction (same reducer, same assembly); the one
// deliberate difference is torn-write discipline: a final line with no
// trailing newline is treated as in-flight (not parsed yet) rather than
// parsed, matching the persistent index's byte-cursor semantics.
export async function parseConversationResumable(
  filePath: string,
  account: string,
): Promise<CachedConversation | null> {
  const resume: ConversationResume = { state: initialConvState(), offset: 0, line: 0 };
  const { messages, textParts, turnDurations, end } = await foldTail(filePath, resume);
  if (messages.length === 0) return null;
  applyTeamInfo(messages, resume.state);
  const conversation = assemble(
    filePath,
    account,
    messages,
    textParts.join(" "),
    turnDurations,
    resume.state,
  );
  return { conversation, resume: { state: resume.state, offset: end.offset, line: end.line } };
}

// Extend a cached conversation with only the bytes appended since its resume
// point. Returns a NEW Conversation with a fresh messages array — the old
// ARRAY is never mutated, but team info discovered in the delta enriches the
// shared message objects in place (the same enrichment a full re-parse would
// emit), so element-level immutability is not guaranteed.
export async function extendConversation(
  previous: Conversation,
  resume: ConversationResume,
  filePath: string,
  account: string,
): Promise<CachedConversation> {
  const { messages: fresh, textParts, turnDurations, end } = await foldTail(filePath, resume);
  const messages = fresh.length > 0 ? previous.messages.concat(fresh) : previous.messages;
  // Team info discovered in the delta back-applies to earlier messages, the
  // same way a full parse applies it once at the end.
  applyTeamInfo(messages, resume.state);
  const fullText =
    textParts.length === 0
      ? previous.fullText
      : previous.fullText
        ? `${previous.fullText} ${textParts.join(" ")}`
        : textParts.join(" ");
  const allTurnDurations = (previous.turnDurations ?? []).concat(turnDurations);
  const conversation = assemble(
    filePath,
    account,
    messages,
    fullText,
    allTurnDurations,
    resume.state,
  );
  return { conversation, resume: { state: resume.state, offset: end.offset, line: end.line } };
}
