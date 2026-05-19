import type { ConversationMeta, Include, SortOrder } from "./types";

export function applySort(metas: ConversationMeta[], order: SortOrder): ConversationMeta[] {
  const out = [...metas];
  switch (order) {
    case "recent":
      out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      break;
    case "oldest":
      out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      break;
    case "messages-desc":
      out.sort((a, b) => b.messageCount - a.messageCount);
      break;
    case "messages-asc":
      out.sort((a, b) => a.messageCount - b.messageCount);
      break;
    case "alpha":
      out.sort((a, b) => {
        const cmp = a.projectName.localeCompare(b.projectName);
        return cmp !== 0 ? cmp : a.preview.localeCompare(b.preview);
      });
      break;
  }
  return out;
}

export function applySinceFilter(metas: ConversationMeta[], since: string): ConversationMeta[] {
  const cutoff = parseSinceCutoff(since);
  return metas.filter((m) => new Date(m.timestamp).getTime() >= cutoff.getTime());
}

export function applyIncludeFilter(
  metas: ConversationMeta[],
  include: Include,
): ConversationMeta[] {
  switch (include) {
    case "all":
      return metas;
    case "conversations":
      return metas.filter((m) => !m.isSubagent && !m.isTeammate);
    case "subagents":
      return metas.filter((m) => m.isSubagent);
    case "teammates":
      return metas.filter((m) => m.isTeammate);
  }
}

export function applyProjectFilter(metas: ConversationMeta[], project: string): ConversationMeta[] {
  const lower = project.toLowerCase();
  return metas.filter(
    (m) =>
      m.projectPath.toLowerCase().includes(lower) || m.projectName.toLowerCase().includes(lower),
  );
}

export function applyAccountFilter(metas: ConversationMeta[], account: string): ConversationMeta[] {
  return metas.filter((m) => m.account === account);
}

export function applyPagination<T>(
  items: T[],
  limit: number,
  offset: number,
): { items: T[]; total: number } {
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
  };
}

export function parseSinceCutoff(value: string): Date {
  const s = value.trim();
  if (!s) throw new Error("Empty --since value");

  // Try ISO date
  const isoMatch = s.match(/^\d{4}-\d{2}-\d{2}$/);
  if (isoMatch) {
    const d = new Date(`${s}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }

  // Try duration: digits + unit
  const durationMatch = s.match(/^(\d+)([hdw])$/);
  if (!durationMatch) {
    throw new Error(
      `Invalid --since value "${s}": expected duration like "7d", "24h", "2w" or ISO date "2006-01-02"`,
    );
  }

  const n = parseInt(durationMatch[1], 10);
  const unit = durationMatch[2];
  let ms: number;
  switch (unit) {
    case "h":
      ms = n * 60 * 60 * 1000;
      break;
    case "d":
      ms = n * 24 * 60 * 60 * 1000;
      break;
    case "w":
      ms = n * 7 * 24 * 60 * 60 * 1000;
      break;
    default:
      throw new Error(`Invalid unit "${unit}"`);
  }

  return new Date(Date.now() - ms);
}
