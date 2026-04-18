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

export function cleanSystemTags(text: string): string {
  return text
    .replace(SYSTEM_TAG_RE, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
