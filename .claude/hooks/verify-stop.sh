#!/usr/bin/env bash
# Stop hook: type-check + lint (+ tests) under the project's Node (.nvmrc).
# Prefers files touched in the agent turn that just stopped (transcript), with
# git dirty-file fallback. Logs steps on stderr; block JSON only on stdout.

set -u

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
JQ="${JQ:-/opt/homebrew/bin/jq}"
if [ ! -x "$JQ" ]; then
  JQ="$(command -v jq || true)"
fi

log() {
  printf '[verify-stop] %s\n' "$*" >&2
}

block() {
  local reason="$1"
  if [ -n "${JQ}" ] && [ -x "${JQ}" ]; then
    printf '%s\n' "$reason" | "$JQ" -Rs '{decision:"block", reason:.}'
  else
    local esc
    esc="$(printf '%s' "$reason" | tr '\n' ' ' | sed 's/"/\\"/g' | cut -c1-800)"
    printf '%s\n' "{\"decision\":\"block\",\"reason\":\"${esc}\"}"
  fi
}

fail() {
  local step="$1"
  local detail="$2"
  log "FAIL step=${step}"
  # Indent multi-line detail for readability on stderr
  printf '%s\n' "$detail" | sed 's/^/[verify-stop]   | /' >&2
  block "Verification failed at step '${step}' under $(node -v 2>/dev/null || echo unknown-node). ${detail}"
  exit 0
}

ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ] || [ ! -f "$ROOT/package.json" ]; then
  ROOT="$(cd "$HOOK_DIR/../.." && pwd)"
fi
cd "$ROOT" || fail "cd-root" "could not cd to project root (${ROOT})"
export VERIFY_STOP_ROOT="$ROOT"
log "step=init root=${ROOT}"

wanted=""
if [ -f "$ROOT/.nvmrc" ]; then
  wanted="$(tr -d '[:space:]' <"$ROOT/.nvmrc")"
fi
wanted_ver="${wanted#v}"

resolve_nvm_bin() {
  local ver="$1"
  local best="" candidate
  for candidate in "$HOME"/.nvm/versions/node/v"${ver}"*/bin; do
    [ -x "$candidate/node" ] || continue
    best="$candidate"
  done
  if [ -n "$best" ]; then
    printf '%s\n' "$best"
    return 0
  fi
  return 1
}

log "step=resolve-node wanted=${wanted:-none}"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  if [ -n "$wanted" ]; then
    nvm use "$wanted" >/dev/null 2>&1 || nvm use "$wanted_ver" >/dev/null 2>&1 || true
  fi
fi
if [ -n "$wanted_ver" ]; then
  match="$(resolve_nvm_bin "$wanted_ver" || true)"
  if [ -n "$match" ]; then
    export PATH="$match:$PATH"
    log "step=resolve-node prepended=${match}"
  fi
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail "resolve-node" "node/npm not found after resolving .nvmrc (${wanted:-unset})"
fi
log "step=resolve-node using=$(command -v node) version=$(node -v) modules=$(node -p process.versions.modules)"

if [ -d "$ROOT/node_modules/better-sqlite3" ]; then
  log "step=abi-check better-sqlite3"
  if ! node -e "const D=require('better-sqlite3'); new D(':memory:').exec('select 1')" >/dev/null 2>&1; then
    fail "abi-check" "better-sqlite3 ABI mismatch under $(node -v) (modules=$(node -p process.versions.modules)). Use Node from .nvmrc (${wanted:-unknown}) or run npm rebuild better-sqlite3."
  fi
  log "step=abi-check ok"
fi

CHANGED_FILE="$(mktemp -t verify-stop-changed.XXXXXX)"
cleanup() { rm -f "$CHANGED_FILE"; }
trap cleanup EXIT

collect_changed() {
  : >"$CHANGED_FILE"

  if [ -n "${VERIFY_STOP_CHANGED_FILES:-}" ]; then
    log "step=changed-files source=env"
    # shellcheck disable=SC2086
    printf '%s\n' ${VERIFY_STOP_CHANGED_FILES} | sed '/^$/d' >>"$CHANGED_FILE"
  else
    local transcript=""
    local stdin_payload=""
    if [ ! -t 0 ]; then
      stdin_payload="$(cat || true)"
    fi
    if [ -n "$stdin_payload" ] && [ -n "$JQ" ] && [ -x "$JQ" ]; then
      transcript="$(printf '%s' "$stdin_payload" | "$JQ" -r '.transcript_path // .transcriptPath // empty' 2>/dev/null || true)"
    fi
    if [ -z "$transcript" ] && [ -n "${VERIFY_STOP_TRANSCRIPT:-}" ]; then
      transcript="$VERIFY_STOP_TRANSCRIPT"
    fi

    if [ -n "$transcript" ] && [ -f "$transcript" ]; then
      log "step=changed-files source=transcript path=${transcript}"
      VERIFY_STOP_ROOT="$ROOT" node "$HOOK_DIR/changed-files-from-transcript.mjs" "$transcript" >>"$CHANGED_FILE" || true
    else
      log "step=changed-files source=transcript skipped (no transcript_path)"
    fi

    if [ ! -s "$CHANGED_FILE" ]; then
      log "step=changed-files source=git-dirty fallback"
      {
        git -C "$ROOT" diff --name-only HEAD 2>/dev/null || true
        git -C "$ROOT" ls-files --others --exclude-standard 2>/dev/null || true
      } >>"$CHANGED_FILE"
    fi
  fi

  local tmp
  tmp="$(mktemp -t verify-stop-norm.XXXXXX)"
  sort -u "$CHANGED_FILE" | while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    if [ -f "$ROOT/$rel" ]; then
      printf '%s\n' "$rel"
    fi
  done >"$tmp"
  mv "$tmp" "$CHANGED_FILE"

  local count
  count="$(wc -l <"$CHANGED_FILE" | tr -d ' ')"
  log "step=changed-files count=${count}"
  if [ "$count" -gt 0 ]; then
    sed 's/^/[verify-stop]   - /' "$CHANGED_FILE" >&2
  fi
}

collect_changed

is_ts() {
  case "$1" in
    *.ts|*.tsx|*.mts|*.cts) return 0 ;;
    *) return 1 ;;
  esac
}

is_biome() {
  case "$1" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.jsonc) return 0 ;;
    *) return 1 ;;
  esac
}

TS_COUNT=0
BIOME_FILES=()
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  if is_ts "$rel"; then
    TS_COUNT=$((TS_COUNT + 1))
  fi
  if is_biome "$rel"; then
    BIOME_FILES+=("$rel")
  fi
done <"$CHANGED_FILE"

run_cmd() {
  local step="$1"
  shift
  log "step=${step} cmd=$*"
  if [ "${VERIFY_STOP_DRY_RUN:-}" = "1" ]; then
    log "step=${step} dry-run skip"
    return 0
  fi
  local out rc
  out="$(mktemp -t verify-stop-out.XXXXXX)"
  "$@" >"$out" 2>&1
  rc=$?
  if [ "$rc" -ne 0 ]; then
    local detail
    detail="$(cat "$out")"
    rm -f "$out"
    fail "$step" "$detail"
  fi
  # Keep a short success summary (last few lines) when verbose tools are noisy
  if [ -s "$out" ]; then
    tail -n 5 "$out" | sed 's/^/[verify-stop]   | /' >&2 || true
  fi
  rm -f "$out"
  log "step=${step} ok"
}

# tsc cannot reliably type-check an arbitrary subset without breaking project
# graph resolution. When any TS file changed, run project-wide --noEmit and log
# the triggering paths. Biome below is truly file-scoped.
if [ "$TS_COUNT" -gt 0 ]; then
  log "step=type-check mode=project-wide reason=${TS_COUNT}_changed_ts_file(s)"
  run_cmd "type-check" npx tsc --noEmit --pretty false
else
  log "step=type-check skip (no changed TypeScript files)"
fi

if [ "${#BIOME_FILES[@]}" -gt 0 ]; then
  log "step=lint mode=scoped files=${#BIOME_FILES[@]}"
  run_cmd "lint" npx biome check "${BIOME_FILES[@]}"
else
  log "step=lint skip (no changed lintable files)"
fi

NEED_TEST=0
if [ "${VERIFY_STOP_SKIP_TEST:-}" = "1" ]; then
  NEED_TEST=0
elif [ "${VERIFY_STOP_ALWAYS_TEST:-}" = "1" ]; then
  NEED_TEST=1
else
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    case "$rel" in
      src/*|__tests__/*|cli/*) NEED_TEST=1; break ;;
      *.ts|*.tsx|*.js|*.mjs|*.cjs) NEED_TEST=1; break ;;
    esac
  done <"$CHANGED_FILE"
fi

if [ "$NEED_TEST" -eq 1 ]; then
  run_cmd "test" npm test
else
  log "step=test skip (no source/test files in changed set)"
fi

log "step=done ok"
exit 0
