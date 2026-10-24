#!/bin/sh
# End-to-end test of smcreader loaded as a Claude Code PLUGIN. Exit code is the verdict.
#
#   sh e2e/plugin.sh                          — claude --plugin-dir <copy>: hook + MCP server
#                                               come from the plugin only (no --settings, no --mcp-config)
#   READER_E2E_NO_PLUGIN=1 sh e2e/plugin.sh   — the same run WITHOUT --plugin-dir
#                                               (negative control: must fail on check 1)
#
# The plugin is a copy of the tracked files WITHOUT node_modules — what a marketplace install gets.
# Its .mcp.json starts the MCP server via npx; the package is the working tree packed with `npm pack`
# (READER_E2E_PACKAGE=registry keeps the version pinned in .mcp.json, i.e. the published one).
#
# Same scenario and verdict as e2e/claude-code.sh (shared e2e/check-stream.js): the model runs
# Bash `seq 1 3000`, then fetches line 2999 through the plugin's reader tool. Verdict from stream-json:
#   (1) the Bash tool_result contains "[READER ctx_" and does NOT contain "1500";
#   (2) a <prefix>reader_* call with that id returned "2999".
# Env: CLAUDE_BIN (default claude), READER_E2E_KEEP=1 keeps the temp dir,
#      READER_E2E_TOOL_PREFIX overrides the tool prefix (default mcp__plugin_smcreader_smcreader__ —
#      Claude Code 2.1.282 names plugin MCP tools mcp__plugin_<plugin>_<server>__<tool>).

REPO=$(cd "$(dirname "$0")/.." && pwd)
CLAUDE_BIN=${CLAUDE_BIN:-claude}
NO_PLUGIN=${READER_E2E_NO_PLUGIN:-}
PREFIX=${READER_E2E_TOOL_PREFIX:-mcp__plugin_smcreader_smcreader__}

command -v "$CLAUDE_BIN" >/dev/null 2>&1 || { echo "E2E-FAIL: $CLAUDE_BIN not found"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "E2E-FAIL: node not found"; exit 1; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/smcreader-plugin-e2e.XXXXXX") || { echo "E2E-FAIL: mktemp"; exit 1; }
[ -n "$READER_E2E_KEEP" ] || trap 'rm -rf "$TMP"' EXIT
# The hook and the MCP server are separate processes; both inherit READER_DIR from claude.
READER_DIR="$TMP/store"
export READER_DIR
mkdir -p "$TMP/project" "$READER_DIR"

if [ -n "$NO_PLUGIN" ]; then
  MODE="no-plugin"
  set --
else
  MODE="plugin"
  PLUGIN="$TMP/plugin"
  mkdir -p "$PLUGIN"
  ( cd "$REPO" && git ls-files -z | xargs -0 tar cf - ) | tar xf - -C "$PLUGIN" || { echo "E2E-FAIL: plugin copy"; exit 1; }
  if [ "${READER_E2E_PACKAGE:-}" != "registry" ]; then
    TGZ=$(cd "$REPO" && npm pack --json --pack-destination "$TMP" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s)[0].filename))') \
      || { echo "E2E-FAIL: npm pack"; exit 1; }
    node -e 'const fs=require("fs"),[f,tgz]=process.argv.slice(1);const m=JSON.parse(fs.readFileSync(f,"utf8"));
      m.smcreader.args=m.smcreader.args.map(a=>a.startsWith("--package=")?"--package="+tgz:a);fs.writeFileSync(f,JSON.stringify(m,null,2))' \
      "$PLUGIN/.mcp.json" "$TMP/$TGZ" || { echo "E2E-FAIL: .mcp.json rewrite"; exit 1; }
  fi
  echo "plugin .mcp.json args: $(node -p 'JSON.stringify(require(process.argv[1]).smcreader.args)' "$PLUGIN/.mcp.json")"
  set -- --plugin-dir "$PLUGIN"
fi

PROMPT="Do exactly two steps, nothing else. Step 1: run the Bash command \`seq 1 3000\`. Step 2: its output will be replaced by a pointer like \"[READER ctx_XXXXXXXX] ...\"; call the tool ${PREFIX}reader_peek with that id, start_line 2999, end_line 2999, and reply with the text of that line. If there is no pointer in the Bash output, reply NO-POINTER and stop."

START=$(date +%s)
( cd "$TMP/project" && "$CLAUDE_BIN" -p "$PROMPT" --model haiku \
    --setting-sources project "$@" \
    --allowedTools "Bash,${PREFIX}reader_peek,${PREFIX}reader_ask,${PREFIX}reader_list" \
    --output-format stream-json --verbose ) > "$TMP/stream.jsonl" 2> "$TMP/stderr.log" < /dev/null
RC=$?
ELAPSED=$(( $(date +%s) - START ))

echo "mode=$MODE claude_rc=$RC elapsed=${ELAPSED}s stream_lines=$(wc -l < "$TMP/stream.jsonl") tmp=$TMP"
[ -s "$TMP/stream.jsonl" ] || { echo "E2E-FAIL: empty stream-json (claude rc=$RC): $(tail -3 "$TMP/stderr.log")"; exit 1; }

# Informational: did the plugin's MCP server connect?
MCP=$(head -1 "$TMP/stream.jsonl" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s);process.stdout.write((m.mcp_servers||[]).filter(x=>/smcreader/.test(x.name)).map(x=>x.name+"="+x.status).join(",")||"none")}catch(_){process.stdout.write("?")}})')
echo "plugin mcp: $MCP"

V=$(node "$REPO/e2e/check-stream.js" "$TMP/stream.jsonl" Bash 1500 2999 "$READER_DIR" "$PREFIX")
printf 'verdict: %s\n' "$V"
field() { printf '%s' "$V" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);const p=process.argv[1].split(".");let x=v;for(const k of p)x=x==null?x:x[k];process.stdout.write(x==null?"":String(x))})' "$1"; }

if [ "$(field check1.ok)" != "true" ]; then
  R=$(field check1.reason)
  printf 'E2E-FAIL: check 1 (interception): %s\n' "$R"
  [ -n "$NO_PLUGIN" ] && printf 'E2E-NEG-REASON: %s\n' "$R"
  exit 1
fi
if [ "$(field check2.ok)" != "true" ]; then
  printf 'E2E-FAIL: check 2 (reader fetch): %s\n' "$(field check2.reason)"
  exit 1
fi
printf 'E2E-OK: mode=%s id=%s fetched-by=%s cost_usd=%s duration_ms=%s\n' "$MODE" "$(field check1.id)" "$(field check2.tool)" "$(field cost_usd)" "$(field duration_ms)"
exit 0
