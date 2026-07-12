import { createReadStream } from "fs";
import { setImmediate as yieldToEventLoop } from "timers/promises";
import type { ConversationMessage, ConversationPage } from "../types";
import {
  applyTeamInfo,
  type ConvReducerState,
  initialConvState,
  reduceConvLine,
} from "./conversation-reducer";
import { YIELD_EVERY_LINES } from "./jsonl-tail-reader";
import type { Checkpoint } from "./repositories/checkpoints.repo";

// Snapshot the parser state every CHECKPOINT_INTERVAL messages.
export const CHECKPOINT_INTERVAL = 500;

// Stream a JSONL file from `startOffset`, folding each complete line through the
// conversation reducer. `onMessage` receives every produced message plus the
// byte offset of the line that FOLLOWS it (a safe resume point) and the current
// state. `onEntry` (optional) sees every parsed entry first — return true to
// consume it before it reaches the reducer (parseConversation's turn_duration
// handling). Returns the offset/line just past the last COMPLETE line consumed
// — a trailing torn line is never included, so the result is a safe resume
// point for a later incremental fold.
export async function streamMessages(
  filePath: string,
  startOffset: number,
  startLine: number,
  state: ConvReducerState,
  // Return true to stop streaming (window filled).
  onMessage: (message: ConversationMessage, nextByteOffset: number, nextLine: number) => boolean,
  onEntry?: (entry: Record<string, unknown>) => boolean,
): Promise<{ offset: number; line: number }> {
  const stream = createReadStream(filePath, { start: startOffset, encoding: "utf8" });
  let buffer = "";
  let offset = startOffset;
  let line = startLine;
  let sinceYield = 0;

  for await (const chunk of stream) {
    buffer += chunk;
    let nl: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line scan
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const lineWithNewline = buffer.slice(0, nl + 1);
      const text = lineWithNewline.trimEnd();
      buffer = buffer.slice(nl + 1);
      offset += Buffer.byteLength(lineWithNewline, "utf8");
      line += 1;

      // Same cooperative yield as the tail reader: without it, buffered chunks
      // drain through microtasks and a full-file walk blocks the event loop.
      if (++sinceYield >= YIELD_EVERY_LINES) {
        sinceYield = 0;
        await yieldToEventLoop();
      }

      if (text.length === 0) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(text);
      } catch {
        continue;
      }
      if (onEntry?.(entry)) continue;
      const message = reduceConvLine(state, entry);
      if (message && onMessage(message, offset, line)) {
        stream.destroy();
        return { offset, line };
      }
    }
  }
  return { offset, line };
}

// Build checkpoints by streaming the file once. Each checkpoint captures the
// byte offset + reducer state immediately AFTER message (k*interval - 1), i.e.
// a clean resume point for message index k*interval. Pass `from` (the last
// persisted checkpoint) to EXTEND an existing chain: the stream resumes from
// its offset/state and only checkpoints past it are returned — an append costs
// O(new bytes), never a re-walk of the immutable prefix.
export async function buildCheckpoints(
  filePath: string,
  interval = CHECKPOINT_INTERVAL,
  from: Checkpoint | null = null,
): Promise<Checkpoint[]> {
  const checkpoints: Checkpoint[] = [];
  const state = from ? from.state : initialConvState();
  let index = from ? from.messageIndex : 0;

  await streamMessages(
    filePath,
    from?.byteOffset ?? 0,
    from?.lineNumber ?? 0,
    state,
    (_msg, nextOffset, nextLine) => {
      index += 1;
      // After consuming `index` messages, if the next message index is a multiple
      // of the interval, snapshot a resume point for it.
      if (index % interval === 0) {
        checkpoints.push({
          messageIndex: index,
          byteOffset: nextOffset,
          lineNumber: nextLine,
          state: structuredClone(state),
        });
      }
      return false; // never stop early — we want the whole file
    },
  );

  return checkpoints;
}

// Read a bounded message window [fromIndex, beforeIndex) plus the total message
// count, seeking from the nearest checkpoint <= fromIndex. `total` requires
// knowing the message count; callers pass it (from the indexed summary) so we
// never scan the whole file just to count.
export async function readPage(
  filePath: string,
  total: number,
  options: { beforeIndex?: number; limit: number },
  floor: Checkpoint | null,
): Promise<ConversationPage> {
  const beforeIndex = options.beforeIndex ?? total;
  const fromIndex = Math.max(0, beforeIndex - options.limit);

  const state = floor ? structuredClone(floor.state) : initialConvState();
  const startOffset = floor ? floor.byteOffset : 0;
  const startLine = floor ? floor.lineNumber : 0;
  let index = floor ? floor.messageIndex : 0;

  const window: ConversationMessage[] = [];
  await streamMessages(filePath, startOffset, startLine, state, (message) => {
    const current = index;
    index += 1;
    if (current >= fromIndex && current < beforeIndex) window.push(message);
    return index >= beforeIndex; // stop once the window is filled
  });

  applyTeamInfo(window, state);
  return { messages: window, total, fromIndex };
}
