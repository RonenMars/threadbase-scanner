#!/usr/bin/env bash
# Stop hook: run lint + tests. On failure, emit a Claude/Cursor block decision.
# Success must print nothing to stdout (only the block JSON is meaningful there).

set -u

ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi
cd "$ROOT" || {
  printf '%s\n' '{"decision":"block","reason":"Verification failed: could not cd to project root."}'
  exit 0
}

# Hook runners often use a minimal PATH without nvm/fnm shims.
if ! command -v npm >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
  fi
fi
if ! command -v npm >/dev/null 2>&1 && [ -d "$HOME/.fnm" ]; then
  export PATH="$HOME/.fnm:$PATH"
  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env)"
  fi
fi
# Last resort: newest nvm node bin dir
if ! command -v npm >/dev/null 2>&1; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin; do
    if [ -x "$candidate/npm" ]; then
      export PATH="$candidate:$PATH"
      break
    fi
  done
fi

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' '{"decision":"block","reason":"Verification failed: npm not found in hook PATH."}'
  exit 0
fi

LOG="$(mktemp -t tb-scanner-verify.XXXXXX)"
cleanup() { rm -f "$LOG"; }
trap cleanup EXIT

if ! (npm run lint && npm test) >"$LOG" 2>&1; then
  # Keep reason short and JSON-safe; full log is on disk for local debugging.
  tail_txt="$(tail -n 20 "$LOG" | tr '\n' ' ' | tr -d '\r' | sed 's/"/\\"/g' | cut -c1-400)"
  printf '%s\n' "{\"decision\":\"block\",\"reason\":\"Verification failed: lint or tests did not pass. ${tail_txt}\"}"
fi

exit 0
