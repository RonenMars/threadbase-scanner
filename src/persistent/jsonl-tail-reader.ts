import { createReadStream } from "fs";
import { setImmediate as yieldToEventLoop } from "timers/promises";
import type { ContentTier } from "../types";
import { type ReducerState, reduceLine } from "./metadata-reducer";

// Cooperatively yield every N folded lines so a full parse of a large file
// (cold index, truncation fallback) never blocks the event loop for its whole
// duration — buffered stream chunks otherwise drain through microtasks without
// ever reaching the macrotask queue.
export const YIELD_EVERY_LINES = 500;

export interface TailReadResult {
  // Byte offset of the first un-consumed byte (start of the trailing partial
  // line, or EOF). Safe to persist as the next cursor.
  newOffset: number;
  newLine: number;
  parsedLines: number;
  badJsonLines: number;
}

// Stream a JSONL file from `startOffset` to EOF, folding each COMPLETE line into
// `state`. A trailing line with no newline (a writer mid-append) is left
// un-consumed: the offset is not advanced past it, so the next pass re-reads it
// once it's complete. Offsets are byte offsets (Buffer.byteLength), never string
// .length, so multibyte content stays aligned. (Spec §7.2–7.4.)
export async function tailReduce(
  filePath: string,
  startOffset: number,
  startLine: number,
  state: ReducerState,
  tier: ContentTier,
): Promise<TailReadResult> {
  const stream = createReadStream(filePath, { start: startOffset, encoding: "utf8" });

  let buffer = "";
  let offset = startOffset;
  let line = startLine;
  let parsedLines = 0;
  let sinceYield = 0;

  for await (const chunk of stream) {
    buffer += chunk;
    let nl: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic line scan
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const lineWithNewline = buffer.slice(0, nl + 1);
      const text = lineWithNewline.trimEnd();
      buffer = buffer.slice(nl + 1);

      if (text.length > 0) {
        try {
          reduceLine(state, JSON.parse(text), tier);
        } catch {
          state.badJsonLines++;
        }
        parsedLines++;
      }

      offset += Buffer.byteLength(lineWithNewline, "utf8");
      line++;
      if (++sinceYield >= YIELD_EVERY_LINES) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
  }

  return { newOffset: offset, newLine: line, parsedLines, badJsonLines: state.badJsonLines };
}
