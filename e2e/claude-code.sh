#!/bin/sh
# End-to-end test of the reader in the real Claude Code CLI. Exit code is the verdict.
#
#   sh e2e/claude-code.sh                       — hook + stdio server from this repo
#   READER_E2E_NO_HOOK=1 sh e2e/claude-code.sh  — the same scenario, settings WITHOUT the hook
#                                                 (negative control: must fail on check 1)
#
# Scenario: the model runs Bash `seq 1 3000`, then fetches line 2999 via mcp__reader__reader_peek
# (or ask). Verdict from stream-json (what the model RECEIVED):
#   (1) the Bash tool_result contains "[READER ctx_" and does NOT contain "1500";
#   (2) a mcp__reader__* call with that id was made, and its tool_result contains "2999".
# Env: CLAUDE_BIN (default claude), READER_E2E_KEEP=1 keeps the temp dir.

REPO=$(cd "$(dirname "$0")/.." && pwd)
CLAUDE_BIN=${CLAUDE_BIN:-claude}
NO_HOOK=${READER_E2E_NO_HOOK:-}

command -v "$CLAUDE_BIN" >/dev/null 2>&1 || { echo "E2E-FAIL: $CLAUDE_BIN not found"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "E2E-FAIL: node not found"; exit 1; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/reader-e2e.XXXXXX") || { echo "E2E-FAIL: mktemp"; exit 1; }
[ -n "$READER_E2E_KEEP" ] || trap 'rm -rf "$TMP"' EXIT
READER_DIR="$TMP/store"
export READER_DIR
mkdir -p "$TMP/project" "$READER_DIR"

if [ -n "$NO_HOOK" ]; then
  printf '{}\n' > "$TMP/settings.json"
  MODE="no-hook"
else
  cat > "$TMP/settings.json" <<EOF
{"hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node $REPO/bin/reader-hook"}]}]}}
EOF
  MODE="hook"
fi
cat > "$TMP/mcp.json" <<EOF
{"mcpServers":{"reader":{"type":"stdio","command":"node","args":["$REPO/bin/reader-mcp"],"env":{"READER_DIR":"$READER_DIR"}}}}
EOF

PROMPT='Do exactly two steps, nothing else. Step 1: run the Bash command `seq 1 3000`. Step 2: its output will be replaced by a pointer like "[READER ctx_XXXXXXXX] ..."; call the tool mcp__reader__reader_peek with that id, start_line 2999, end_line 2999, and reply with the text of that line. If there is no pointer in the Bash output, reply NO-POINTER and stop.'

START=$(date +%s)
( cd "$TMP/project" && "$CLAUDE_BIN" -p "$PROMPT" --model haiku \
    --setting-sources project --settings "$TMP/settings.json" \
    --mcp-config "$TMP/mcp.json" --strict-mcp-config \
    --allowedTools "Bash,mcp__reader__reader_peek,mcp__reader__reader_ask,mcp__reader__reader_list" \
    --output-format stream-json --verbose ) > "$TMP/stream.jsonl" 2> "$TMP/stderr.log" < /dev/null
RC=$?
ELAPSED=$(( $(date +%s) - START ))

echo "mode=$MODE claude_rc=$RC elapsed=${ELAPSED}s stream_lines=$(wc -l < "$TMP/stream.jsonl") tmp=$TMP"
[ -s "$TMP/stream.jsonl" ] || { echo "E2E-FAIL: empty stream-json (claude rc=$RC): $(tail -3 "$TMP/stderr.log")"; exit 1; }

V=$(node "$REPO/e2e/check-stream.js" "$TMP/stream.jsonl" Bash 1500 2999 "$READER_DIR")
printf 'verdict: %s\n' "$V"
field() { printf '%s' "$V" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const p=process.argv[1].split(".");let x=v;for(const k of p)x=x==null?x:x[k];process.stdout.write(x==null?"":String(x))})' "$1"; }

if [ "$(field check1.ok)" != "true" ]; then
  R=$(field check1.reason)
  printf 'E2E-FAIL: check 1 (interception): %s\n' "$R"
  [ -n "$NO_HOOK" ] && printf 'E2E-NEG-REASON: %s\n' "$R"
  exit 1
fi
if [ "$(field check2.ok)" != "true" ]; then
  printf 'E2E-FAIL: check 2 (reader fetch): %s\n' "$(field check2.reason)"
  exit 1
fi
printf 'E2E-OK: mode=%s id=%s fetched-by=%s cost_usd=%s duration_ms=%s\n' "$MODE" "$(field check1.id)" "$(field check2.tool)" "$(field cost_usd)" "$(field duration_ms)"
exit 0
