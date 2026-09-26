const SYSTEM_TAGS = [
  "system-reminder",
  "command-name",
  "command-message",
  "command-args",
  "ide_selection",
  "ide_opened_file",
  "local-command-stdout",
  "local-command-caveat",
  "retrieval_status",
  "task_id",
  "task_type",
  "task-id",
  "task-notification",
  "fast_mode_info",
  "persisted-output",
  "tool_use_error",
  "user-prompt-submit-hook",
  "thinking",
  "ask_user",
  "teammate-message",
];

const SYSTEM_TAG_RE = new RegExp(`<(${SYSTEM_TAGS.join("|")})[^>]*>[\\s\\S]*?<\\/\\1>`, "g");

// The CLI wraps an oversized paste in <pasted_content id="XXXX"> /
// </pasted_content id="XXXX"> (the closing tag repeats the id, so it isn't a
// SYSTEM_TAGS-style `<\/\1>` pair) or a plain </pasted_content>. Unlike the
// system tags above, this wraps the user's real prompt, so only the tag lines
// are dropped and the inner text is kept.
const PASTED_CONTENT_RE =
  /<pasted_content id="[0-9a-f]{4}">([\s\S]*?)<\/pasted_content(?: id="[0-9a-f]{4}")?>/g;

export function cleanSystemTags(text: string): string {
  return text
    .replace(SYSTEM_TAG_RE, "")
    .replace(PASTED_CONTENT_RE, "$1")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
