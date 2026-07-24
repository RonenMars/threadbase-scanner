#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="update-baseline"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/log.sh
source "$SCRIPT_DIR/lib/log.sh"
# shellcheck source=lib/baseline-paths.sh
source "$SCRIPT_DIR/lib/baseline-paths.sh"

script_step "init" "fixtures=${FIXTURES_DIR}"

if [ -f "$BASELINE_LIVE" ]; then
  script_step "save-prev" "to=${BASELINE_PREV}"
  cp "$BASELINE_LIVE" "$BASELINE_PREV"
else
  script_step "save-prev" "skip (no existing baseline)"
fi

script_step "capture-live"
bash "$SCRIPT_DIR/capture-live.sh"
script_step "done" "ok"
