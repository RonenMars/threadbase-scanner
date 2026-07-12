import type { Database } from "better-sqlite3";
import type { ConvReducerState } from "../conversation-reducer";

export interface Checkpoint {
  messageIndex: number;
  byteOffset: number;
  lineNumber: number;
  state: ConvReducerState;
}

interface CheckpointRow {
  message_index: number;
  byte_offset: number;
  line_number: number;
  parser_state: string;
}

// Stores periodic seek points for a conversation so a page near the end of a
// large file can be read without parsing from byte 0.
export class CheckpointsRepo {
  constructor(private db: Database) {}

  replaceAll(sourcePath: string, checkpoints: Checkpoint[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM message_checkpoints WHERE source_path = ?").run(sourcePath);
      const insert = this.db.prepare(
        `INSERT INTO message_checkpoints
           (source_path, message_index, byte_offset, line_number, parser_state)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const c of checkpoints) {
        insert.run(sourcePath, c.messageIndex, c.byteOffset, c.lineNumber, JSON.stringify(c.state));
      }
    });
    tx();
  }

  // Insert checkpoints without touching existing rows. Appends never invalidate
  // the chain covering the immutable prefix (Kafka sparse-index style); rows are
  // only ever removed on truncation/replace or deletion.
  append(sourcePath: string, checkpoints: Checkpoint[]): void {
    const tx = this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO message_checkpoints
           (source_path, message_index, byte_offset, line_number, parser_state)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const c of checkpoints) {
        insert.run(sourcePath, c.messageIndex, c.byteOffset, c.lineNumber, JSON.stringify(c.state));
      }
    });
    tx();
  }

  // The latest checkpoint at or before `messageIndex`, or null if none (read
  // from the file start). Lets a page seek to the nearest prior anchor.
  floor(sourcePath: string, messageIndex: number): Checkpoint | null {
    const row = this.db
      .prepare(
        `SELECT message_index, byte_offset, line_number, parser_state
         FROM message_checkpoints
         WHERE source_path = ? AND message_index <= ?
         ORDER BY message_index DESC LIMIT 1`,
      )
      .get(sourcePath, messageIndex) as CheckpointRow | undefined;
    return row ? toCheckpoint(row) : null;
  }

  // The highest-index checkpoint for a file, or null if none. The resume point
  // for extending the chain after an append.
  last(sourcePath: string): Checkpoint | null {
    const row = this.db
      .prepare(
        `SELECT message_index, byte_offset, line_number, parser_state
         FROM message_checkpoints
         WHERE source_path = ?
         ORDER BY message_index DESC LIMIT 1`,
      )
      .get(sourcePath) as CheckpointRow | undefined;
    return row ? toCheckpoint(row) : null;
  }

  count(sourcePath: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM message_checkpoints WHERE source_path = ?")
        .get(sourcePath) as { n: number }
    ).n;
  }

  remove(sourcePath: string): void {
    this.db.prepare("DELETE FROM message_checkpoints WHERE source_path = ?").run(sourcePath);
  }
}

function toCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    messageIndex: row.message_index,
    byteOffset: row.byte_offset,
    lineNumber: row.line_number,
    state: JSON.parse(row.parser_state) as ConvReducerState,
  };
}
