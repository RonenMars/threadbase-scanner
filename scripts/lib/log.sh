#!/usr/bin/env bash
# Shared step logging for scripts/*.sh. Source after setting SCRIPT_NAME.
# Usage:
#   SCRIPT_NAME=capture-live
#   # shellcheck source=log.sh
#   source "$(cd "$(dirname "$0")" && pwd)/lib/log.sh"
#   script_step "init" "root=$ROOT"

script_log() {
  printf '[%s] %s\n' "${SCRIPT_NAME:-script}" "$*" >&2
}

script_step() {
  local step="$1"
  shift || true
  if [ "$#" -gt 0 ]; then
    script_log "step=${step} $*"
  else
    script_log "step=${step}"
  fi
}

script_fail() {
  local step="$1"
  shift || true
  script_log "FAIL step=${step}"
  if [ "$#" -gt 0 ]; then
    printf '%s\n' "$*" | sed "s/^/[${SCRIPT_NAME:-script}]   | /" >&2
  fi
  return 1
}
