/**
 * read-guard — PreToolUse guard for large Reads: a full Read of a large file is
 * not let into the context window, only a targeted one (limit/offset) or navigation.
 *
 * A factory (rather than a ready-made hook), because the threshold and the set of
 * alternatives depend on the agent's profile (whether it has a reader, whether Read
 * output is intercepted). A denial MUST lead to a working path: an agent told "no"
 * without "but you can do this" simply loses access to the information.
 *
 * Fail-open on anything unclear (no file_path, stat failed, binary file) —
 * let Read return its own error; blinding the agent costs more than not compressing.
 */

const fs = require('fs');

const DEFAULT_THRESHOLD = 32 * 1024;
// Binary formats are not guarded — they can't be read by line ranges.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb)$/i;
// How much of the file to measure: sources and logs being edited are hundreds of KB; the tail
// of a giant log (beyond 4 MB) won't refine the chunk size, and the hook blocks every Read.
const MEASURE_BYTES = 4 * 1024 * 1024;
const CHUNK_FIT_SHARE = 0.95;

/**
 * Chunk size for a targeted Read that will get past output interception. For a subagent there
 * is a second guard behind this one — Read output larger than outputCap goes to the reader
 * (Read interception, intercept-hook). Given a bare "Read with limit" hint, an agent would pick
 * e.g. limit 200 on a 17 KB file and get a reader pointer instead of the text. Average line
 * length doesn't work — on an uneven file a chunk based on the average still ends up in the
 * reader, while a worst-case guarantee chops the file into tiny pieces. We take the largest N
 * such that 95% of all windows of N consecutive lines are shorter than the cap, whatever line
 * you start from; the hint itself covers the dense spots.
 * Measured in characters, like the interception itself (file.content without line numbers).
 * @returns {{per: number, total: number}|null} lines per read and lines in the file; null — don't chunk
 */
function chunkLines(file, size, outputCap) {
  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const buf = Buffer.alloc(Math.min(size, MEASURE_BYTES));
    text = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const parts = text.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();   // trailing newline is not a line
  const lens = parts.map(l => l.length + 1);
  const pre = [0];
  for (const l of lens) pre.push(pre[pre.length - 1] + l);
  const fits = (n) => {
    let bad = 0;
    for (let i = n; i < pre.length; i++) if (pre[i] - pre[i - n] >= outputCap) bad++;
    return bad <= (pre.length - n) * (1 - CHUNK_FIT_SHARE);
  };
  if (!fits(1)) return null;                                   // lines longer than the cap — can't chunk by lines
  let lo = 1, hi = lens.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
  const per = lo >= 100 ? lo - lo % 10 : lo;
  const total = size <= MEASURE_BYTES ? lens.length : Math.round(lens.length * size / text.length);
  return { per, total };
}

/**
 * Denial text. Every item is an executable command, not advice like "read less".
 * @param {number} kb file size
 * @param {number} thresholdKb threshold
 * @param {boolean} hasReader whether mcp__reader__* is available to the agent (without it, the reader item is a trap)
 * @param {{capKb: number, per?: number, total?: number}} [cap] the agent's Read output interception
 */
function denyReason(kb, thresholdKb, hasReader, cap) {
  const chunk = !cap ? ''
    : cap.per
      ? `, but output over ${cap.capKb}KB goes to the reader — read ${cap.per} lines at a time (file has ~${cap.total}): offset 1, ${cap.per + 1}, ${2 * cap.per + 1}…; if a chunk went to the reader (dense section), retry with half the limit`
      : `, but output over ${cap.capKb}KB goes to the reader — read chunks smaller than ${cap.capKb}KB`;
  const ways = [
    `Read(file_path, offset, limit) — targeted read; Read with limit/offset is ALWAYS allowed${chunk}`,
    'Grep(pattern, path, -n) — returns line numbers, then do a targeted Read at them',
    ...(hasReader
      ? ['mcp__reader__reader_open({path, briefing}) + mcp__reader__reader_ask(id, question) — the file goes to a separate reader, only the answers enter your context; mcp__reader__reader_peek(id, start_line, end_line) gives a verbatim slice']
      : []),
    "Bash: sed -n '120,180p' file / head -80 / tail -80 / grep -n",
  ];
  // Without the last line, an agent that read the file via the reader would pull a separate
  // full copy for Edit: Edit requires a Read, and a targeted one is enough for the whole file.
  return `File is ${kb}KB (threshold ${thresholdKb}KB): a full Read would bloat your context. ` +
    `Read it this way instead:\n` + ways.map((w, i) => `${i + 1}) ${w}`).join('\n') +
    `\nEdit does not need a full Read: after a targeted Read (offset/limit), Edit works on the whole file.`;
}

/**
 * @param {object} opts
 * @param {number} [opts.threshold] bytes; larger — deny Read without limit/offset
 * @param {boolean} [opts.hasReader] whether the agent has mcp__reader__*
 * @param {number} [opts.outputCap] chars; larger Read output is intercepted into the reader (8 KB for subagents)
 * @param {Function} [opts.log]
 * @returns {Function} PreToolUse callback (matcher 'Read')
 */
function createReadGuardHook({ threshold = DEFAULT_THRESHOLD, hasReader = false, outputCap = 0, log = console.log } = {}) {
  const thresholdKb = Math.round(threshold / 1024);
  return async function preToolUseReadGuard(input /*, toolUseID, { signal } */) {
    try {
      if (!input || input.tool_name !== 'Read') return {};
      const ti = input.tool_input || {};
      if (ti.limit || ti.offset) return {};                       // targeted read — always allowed
      if (!ti.file_path || BINARY_EXT.test(ti.file_path)) return {};
      const size = fs.statSync(ti.file_path).size;
      if (size <= threshold) return {};
      const kb = Math.round(size / 1024);
      try { log(`[read-guard] deny: ${ti.file_path} (${kb}KB)`); } catch (_) {}
      let cap = null;
      if (outputCap) {
        cap = { capKb: Math.round(outputCap / 1024) };
        try { Object.assign(cap, chunkLines(ti.file_path, size, outputCap)); } catch (_) { /* no numbers — generic hint */ }
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: denyReason(kb, thresholdKb, hasReader, cap),
        },
      };
    } catch (_) {
      return {}; // no file / stat failed — let Read return its own error
    }
  };
}

module.exports = { createReadGuardHook, denyReason, chunkLines, DEFAULT_THRESHOLD, BINARY_EXT };
