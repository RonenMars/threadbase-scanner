#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/../__fixtures__"
BASELINE="$FIXTURES_DIR/baseline-live.jsonl"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CLAUDE_PROJECTS_DIR="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"

echo "Running ${CLAUDE_BIN} --print to capture a live conversation..."
"$CLAUDE_BIN" --print "what is 1+1" > /dev/null 2>&1

# Find the most recently modified .jsonl file
LATEST=$(find "$CLAUDE_PROJECTS_DIR" -name "*.jsonl" -not -path "*/memory/*" -not -path "*/tool-results/*" -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)

if [ -z "$LATEST" ]; then
  echo "ERROR: No JSONL file found after running claude --print"
  exit 1
fi

echo "Captured: $LATEST"
cp "$LATEST" "$BASELINE"
echo "Saved to: $BASELINE"

echo "Validating against previous baseline..."
npx tsx "$SCRIPT_DIR/validate-live.ts"
