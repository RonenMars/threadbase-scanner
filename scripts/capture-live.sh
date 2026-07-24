#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="capture-live"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/log.sh
source "$SCRIPT_DIR/lib/log.sh"
# shellcheck source=lib/baseline-paths.sh
source "$SCRIPT_DIR/lib/baseline-paths.sh"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CLAUDE_PROJECTS_DIR="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"

script_step "init" "fixtures=${FIXTURES_DIR}"
script_step "claude-run" "bin=${CLAUDE_BIN}"
"$CLAUDE_BIN" --print "what is 1+1" > /dev/null 2>&1

script_step "find-latest-jsonl" "projects=${CLAUDE_PROJECTS_DIR}"
LATEST=$(find "$CLAUDE_PROJECTS_DIR" -name "*.jsonl" -not -path "*/memory/*" -not -path "*/tool-results/*" -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)

if [ -z "$LATEST" ]; then
  script_fail "find-latest-jsonl" "No JSONL file found after running ${CLAUDE_BIN} --print" || exit 1
fi

script_step "save-baseline" "from=${LATEST} to=${BASELINE_LIVE}"
cp "$LATEST" "$BASELINE_LIVE"

script_step "validate-live"
npx tsx "$SCRIPT_DIR/validate-live.ts"
script_step "done" "ok"
