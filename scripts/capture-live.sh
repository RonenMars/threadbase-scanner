#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/../__fixtures__"
BASELINE="$FIXTURES_DIR/baseline-live.jsonl"

echo "Running claude --print to capture a live conversation..."
claude --print "what is 1+1" > /dev/null 2>&1

# Find the most recently modified .jsonl file
LATEST=$(find ~/.claude/projects -name "*.jsonl" -not -path "*/memory/*" -not -path "*/tool-results/*" -type f -print0 | xargs -0 ls -t | head -1)

if [ -z "$LATEST" ]; then
  echo "ERROR: No JSONL file found after running claude --print"
  exit 1
fi

echo "Captured: $LATEST"
cp "$LATEST" "$BASELINE"
echo "Saved to: $BASELINE"

echo "Validating against previous baseline..."
npx tsx "$SCRIPT_DIR/validate-live.ts"
