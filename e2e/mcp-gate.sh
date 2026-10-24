#!/bin/sh
# Gate: does Claude Code apply updatedToolOutput from a PostToolUse command hook to the output
# of an MCP tool (shape {content:[...]})? The fixture fixture-mcp.js returns seq 1..3000,
# the hook is bin/reader-hook with READER_ALLOWLIST=mcp__fixture__big_output.
# Exit 0 — the replacement reached the model; exit 1 — it did not (prints the reason).

REPO=$(cd "$(dirname "$0")/.." && pwd)
CLAUDE_BIN=${CLAUDE_BIN:-claude}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/reader-gate.XXXXXX") || exit 1
[ -n "$READER_E2E_KEEP" ] || trap 'rm -rf "$TMP"' EXIT
READER_DIR="$TMP/store"; export READER_DIR
mkdir -p "$TMP/project" "$READER_DIR"

cat > "$TMP/settings.json" <<EOF
{"hooks":{"PostToolUse":[{"matcher":"mcp__fixture__big_output","hooks":[{"type":"command","command":"READER_ALLOWLIST=mcp__fixture__big_output node $REPO/bin/reader-hook"}]}]}}
EOF
cat > "$TMP/mcp.json" <<EOF
{"mcpServers":{"fixture":{"type":"stdio","command":"node","args":["$REPO/e2e/fixture-mcp.js"],"env":{"FIXTURE_ENV_DUMP":"$TMP/mcp-env.txt"}}}}
EOF

( cd "$TMP/project" && "$CLAUDE_BIN" -p 'Call the tool mcp__fixture__big_output once, then reply DONE.' --model haiku \
    --setting-sources project --settings "$TMP/settings.json" \
    --mcp-config "$TMP/mcp.json" --strict-mcp-config --allowedTools "mcp__fixture__big_output" \
    --output-format stream-json --verbose ) > "$TMP/stream.jsonl" 2> "$TMP/stderr.log" < /dev/null

V=$(node "$REPO/e2e/check-stream.js" "$TMP/stream.jsonl" mcp__fixture__big_output 1500 2999)
printf 'verdict: %s\n' "$V"
printf 'store: %s\n' "$(ls "$READER_DIR" | tr '\n' ' ')"
printf 'mcp env:\n%s\n' "$(cat "$TMP/mcp-env.txt" 2>/dev/null)"
case "$V" in
  *'"check1":{"ok":true'*) echo "GATE: MCP updatedToolOutput APPLIED"; exit 0 ;;
  *) echo "GATE: MCP updatedToolOutput NOT applied"; exit 1 ;;
esac
