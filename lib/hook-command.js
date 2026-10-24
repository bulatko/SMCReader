/**
 * hook-command — body of bin/reader-hook, a Claude Code command hook.
 *
 * PostToolUse: large output from an allowlisted tool goes into the store ($READER_DIR); the
 * response is hookSpecificOutput.updatedToolOutput in the same shape as tool_response, holding
 * the pointer "[READER ctx_…] <tool> output intercepted: N bytes, L lines …" plus head/tail.
 * PreToolUse (only when $READER_READ_GUARD > 0): a full Read of a file above the threshold is
 * denied with working alternatives (lib/read-guard.js).
 *
 * The document owner is the session_id from stdin (a subagent gets `<session>/agent:<id>`).
 * Fail-open: any error → empty response, the output passes through unchanged, exit 0.
 */

'use strict';

const fs = require('fs');
const { createReaderStore } = require('./reader-store');
const { createInterceptHook, extractText } = require('./intercept-hook');
const { createReadGuardHook } = require('./read-guard');
const { loadConfig } = require('./config');

function makeLog(cfg) {
  if (!cfg.logFile) return () => {};
  return (msg) => {
    try { fs.appendFileSync(cfg.logFile, `${new Date().toISOString()} ${msg}\n`); } catch (_) { /* logging never breaks the hook */ }
  };
}

/**
 * @param {object} input  JSON from the hook's stdin
 * @param {object} [env]
 * @returns {Promise<object>} hook response ({} means change nothing)
 */
async function handleHookInput(input, env = process.env) {
  const cfg = loadConfig(env);
  const log = makeLog(cfg);
  try {
    if (!input || typeof input !== 'object') return {};
    const event = input.hook_event_name;

    if (event === 'PreToolUse') {
      if (!cfg.readGuard) return {};
      return await createReadGuardHook({ threshold: cfg.readGuard, hasReader: true, log })(input);
    }
    if (event !== undefined && event !== 'PostToolUse') return {};

    // Cheap prefilter BEFORE creating the store: the hook runs on every tool call, and the
    // store reads its directory on creation (sweep). Small output costs zero file operations.
    if (!cfg.allowlist.includes(input.tool_name)) return {};
    const { text } = extractText(input.tool_response);
    if (!text || text.length < cfg.threshold) return {};

    const store = createReaderStore({ dir: cfg.dir, log });
    const owner = typeof input.session_id === 'string' && input.session_id ? input.session_id : cfg.owner;
    const P = cfg.toolPrefix;
    const askHint = P ? (id) => `Full output is in reader ${id}: ${P}reader_ask(id, question) to analyze, ${P}reader_peek(id, start_line, end_line) for exact lines, ${P}reader_close(id) when done.` : undefined;
    const hook = createInterceptHook({ store, threshold: cfg.threshold, allowlist: cfg.allowlist, log, owner, askHint });
    return await hook(input);
  } catch (e) {
    log(`[reader-hook] error (passing output through): ${e.message}`);
    return {};
  }
}

/** Read all of stdin, handle it, print the response. Never throws. */
async function main({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  let raw = '';
  try {
    stdin.setEncoding('utf8');
    for await (const chunk of stdin) raw += chunk;
  } catch (_) { return 0; }
  let out = {};
  try { out = await handleHookInput(JSON.parse(raw), env); } catch (_) { out = {}; }
  if (out && Object.keys(out).length) {
    try { stdout.write(JSON.stringify(out)); } catch (_) { /* fail-open */ }
  }
  return 0;
}

module.exports = { handleHookInput, main };
