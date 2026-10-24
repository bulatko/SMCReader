/**
 * config — settings from the environment. The hook and the server are separate processes, so
 * the only shared channel between them is the $READER_DIR directory and the same variables.
 */

'use strict';

const os = require('os');
const path = require('path');
const { DEFAULT_ALLOWLIST, DEFAULT_THRESHOLD } = require('./intercept-hook');

const int = (v, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const list = (v, dflt) => (v && v.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean) : dflt);

function loadConfig(env = process.env) {
  return {
    dir: env.READER_DIR || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'smcreader'),
    threshold: int(env.READER_THRESHOLD, DEFAULT_THRESHOLD),
    allowlist: list(env.READER_ALLOWLIST, DEFAULT_ALLOWLIST),
    owner: env.READER_OWNER || undefined,
    askFormat: env.READER_ASK_FORMAT === 'prose' ? 'prose' : 'lines',
    readGuard: int(env.READER_READ_GUARD, 0),   // bytes; 0 — Read guard disabled
    logFile: env.READER_LOG || '',
    // Prefix of reader tool names in the pointer hint: depends on how the server is connected
    // (claude mcp add smcreader → mcp__smcreader__, plugin → mcp__plugin_smcreader_smcreader__).
    toolPrefix: env.READER_TOOL_PREFIX && /^[A-Za-z0-9_-]+$/.test(env.READER_TOOL_PREFIX) ? env.READER_TOOL_PREFIX : '',
  };
}

module.exports = { loadConfig };
