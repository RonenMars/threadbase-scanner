#!/usr/bin/env bash
# Smoke / unit checks for verify-stop.sh and changed-files-from-transcript.mjs
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/.claude/hooks/verify-stop.sh"
EXTRACT="$ROOT/.claude/hooks/changed-files-from-transcript.mjs"
PASS=0
FAIL=0

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "PASS $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL $name"
    echo "  got:  $got"
    echo "  want: $want"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local name="$1" hay="$2" needle="$3"
  if printf '%s' "$hay" | grep -qF "$needle"; then
    echo "PASS $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL $name (missing: $needle)"
    echo "$hay" | sed 's/^/  | /' | head -n 40
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local name="$1" hay="$2" needle="$3"
  if printf '%s' "$hay" | grep -qF "$needle"; then
    echo "FAIL $name (unexpected: $needle)"
    FAIL=$((FAIL + 1))
  else
    echo "PASS $name"
    PASS=$((PASS + 1))
  fi
}

FIXTURE="$(mktemp -t verify-stop-fixture.XXXXXX).jsonl"
cleanup() { rm -f "$FIXTURE"; }
trap cleanup EXIT

# Last user turn, then assistant edits two files (and a Read that must be ignored)
cat >"$FIXTURE" <<EOF
{"type":"user","message":{"content":[{"type":"text","text":"do stuff"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"ok"},{"type":"tool_use","name":"Read","input":{"file_path":"$ROOT/package.json"}},{"type":"tool_use","name":"Edit","input":{"file_path":"$ROOT/src/parser.ts"}},{"type":"tool_use","name":"Write","input":{"file_path":"$ROOT/__tests__/parser.test.ts","content":""}}]}}
EOF

got="$(VERIFY_STOP_ROOT="$ROOT" node "$EXTRACT" "$FIXTURE" | sort | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
assert_eq "extract last-turn write paths" "$got" "__tests__/parser.test.ts src/parser.ts"

# Older turn edits must not appear
cat >"$FIXTURE" <<EOF
{"type":"user","message":{"content":[{"type":"text","text":"old"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"$ROOT/README.md"}}]}}
{"type":"user","message":{"content":[{"type":"text","text":"new"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"$ROOT/src/types.ts"}}]}}
EOF
got="$(VERIFY_STOP_ROOT="$ROOT" node "$EXTRACT" "$FIXTURE" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
assert_eq "extract ignores prior turn" "$got" "src/types.ts"

# Dry-run with env-injected markdown-only change → skip type-check/lint/test
out="$(
  CLAUDE_PROJECT_DIR="$ROOT" \
  VERIFY_STOP_DRY_RUN=1 \
  VERIFY_STOP_CHANGED_FILES="README.md" \
  bash "$HOOK" 2>&1 >/dev/null || true
)"
assert_contains "dry-run logs init" "$out" "step=init"
assert_contains "dry-run skips type-check" "$out" "step=type-check skip"
assert_contains "dry-run skips lint" "$out" "step=lint skip"
assert_contains "dry-run skips test" "$out" "step=test skip"
assert_contains "dry-run done" "$out" "step=done ok"
assert_not_contains "dry-run no block json on stderr mix" "$out" '"decision":"block"'

# Dry-run with a TS file → would type-check + lint + test
out="$(
  CLAUDE_PROJECT_DIR="$ROOT" \
  VERIFY_STOP_DRY_RUN=1 \
  VERIFY_STOP_CHANGED_FILES="src/parser.ts" \
  bash "$HOOK" 2>&1 >/dev/null || true
)"
assert_contains "ts change schedules type-check" "$out" "step=type-check mode=project-wide"
assert_contains "ts change schedules lint" "$out" "step=lint mode=scoped"
assert_contains "ts change schedules test" "$out" "step=test"
assert_contains "ts dry-run skips execution" "$out" "dry-run skip"

# Transcript via Stop-hook stdin JSON
out="$(
  CLAUDE_PROJECT_DIR="$ROOT" \
  VERIFY_STOP_DRY_RUN=1 \
  bash "$HOOK" <<<"{\"transcript_path\":\"$FIXTURE\"}" 2>&1 >/dev/null || true
)"
assert_contains "stdin transcript used" "$out" "source=transcript"
assert_contains "stdin yields types.ts" "$out" "src/types.ts"

# Real scoped biome + tsc on a known-good file (skip full suite for speed)
out="$(
  CLAUDE_PROJECT_DIR="$ROOT" \
  VERIFY_STOP_CHANGED_FILES="src/tiers.ts" \
  VERIFY_STOP_SKIP_TEST=1 \
  bash "$HOOK" 2>&1
)"
stdout_only="$(
  CLAUDE_PROJECT_DIR="$ROOT" \
  VERIFY_STOP_CHANGED_FILES="src/tiers.ts" \
  VERIFY_STOP_SKIP_TEST=1 \
  bash "$HOOK" 2>/dev/null
)"
assert_eq "success stdout empty" "$stdout_only" ""
assert_contains "real lint ok" "$out" "step=lint ok"
assert_contains "real type-check ok" "$out" "step=type-check ok"
assert_contains "real test skipped" "$out" "step=test skip"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
