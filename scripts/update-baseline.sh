#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURES_DIR="$SCRIPT_DIR/../__fixtures__"
BASELINE="$FIXTURES_DIR/baseline-live.jsonl"

if [ -f "$BASELINE" ]; then
  cp "$BASELINE" "$FIXTURES_DIR/baseline-live.prev.jsonl"
  echo "Previous baseline saved as baseline-live.prev.jsonl"
fi

bash "$SCRIPT_DIR/capture-live.sh"
echo "Baseline updated."
