# Live Copilot CLI captures

Sanitized `events.jsonl` files from real Copilot CLI sessions.
`__tests__/copilot-live-fixtures.test.ts` runs every `*.jsonl` here through the real parser.
The suite skips cleanly while this directory holds no `.jsonl` file.

Capture workflow: see "Capturing live Copilot events" in the top-level README.

Rules:

- Only files written by `scripts/capture-copilot-events.mjs` belong here.
- Read the whole file before committing it.
  The script redacts ids, home paths, usernames, hostnames, emails and token-shaped strings, but free text is kept as typed.
