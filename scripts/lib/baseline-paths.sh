#!/usr/bin/env bash
# Shared live-baseline paths for capture-live / update-baseline.
# Requires SCRIPT_DIR (absolute path to scripts/).

FIXTURES_DIR="${FIXTURES_DIR:-$SCRIPT_DIR/../__fixtures__}"
BASELINE_LIVE="${BASELINE_LIVE:-$FIXTURES_DIR/baseline-live.jsonl}"
BASELINE_PREV="${BASELINE_PREV:-$FIXTURES_DIR/baseline-live.prev.jsonl}"
