/**
 * reader-haiku — the dialog layer of the reader MCP: a Haiku reader that holds
 * the document in its context and answers questions from the main agent.
 *
 * Transport: query({model:'haiku'}) from claude-agent-sdk (Claude Code OAuth,
 * or ANTHROPIC_API_KEY — same as Claude Code itself). The first ask creates a
 * Haiku session with framing + briefing + numbered document; subsequent asks
 * resume the same session (the document stays in its context, questions are cheap).
 * The transport can be swapped inside ask() without changing the store or tools.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { lineBaseOf } = require('./reader-store');

// cwd for Haiku sessions: their transcripts go to a separate Claude Code project, not the agent's project.
// The directory is created on the first question, not at module load (the hook and tests don't need it).
const workDir = () => process.env.READER_WORK_DIR || path.join(os.tmpdir(), 'reader-work');

// Claude Code binary for the Haiku sessions. The SDK ships its own as an optional per-platform package
// (~280 MB); the plugin starts the server via `npx --omit=optional` and reuses the user's `claude`.
// Order: $READER_CLAUDE_EXECUTABLE → the SDK's bundled binary, if installed → `claude` on PATH.
function bundledBinaryInstalled() {
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const name of [base, `${base}-musl`]) {
    try { require.resolve(`${name}/package.json`); return true; } catch (_) { /* not installed */ }
  }
  return false;
}

function findOnPath(cmd, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch (_) { /* next */ }
    }
  }
  return null;
}

/** @returns {string|undefined} path for options.pathToClaudeCodeExecutable; undefined = the SDK's bundled binary */
function resolveClaudeExecutable({ env = process.env, bundled = bundledBinaryInstalled } = {}) {
  if (env.READER_CLAUDE_EXECUTABLE) return env.READER_CLAUDE_EXECUTABLE;
  if (bundled()) return undefined;
  const found = findOnPath('claude', env);
  if (!found) {
    throw new Error('reader_ask needs Claude Code: put `claude` on PATH or set READER_CLAUDE_EXECUTABLE '
      + '(the Agent SDK\'s bundled binary is not installed)');
  }
  return found;
}

const READER_FRAMING = `You are a document reader serving a main AI agent. Below is a document with line numbers ("N<TAB>text") and a BRIEFING explaining why the agent opened it.

RULES (strict, apply to every answer in this conversation):
1. ANSWER concisely and densely. Every factual claim cites line numbers: (L120) or (L120-134). If the answer is not in the document, say "not in document" — NEVER invent or fill gaps from general knowledge.
2. VERBATIM PRESERVATION: reproduce numbers, file paths, identifiers, versions, URLs and error-message text EXACTLY as written, character for character. Never round numbers, never paraphrase error text.
3. End EVERY response with a "NOTICED:" section — important things the agent did NOT ask about: errors, warnings, anomalies, contradictions, secrets/keys, TODOs/FIXMEs, deprecations, suspicious values. One line each with citations. Do not repeat items already reported earlier in this conversation. If nothing new: exactly "NOTICED: nothing new".
4. If a question is ambiguous, answer the most likely reading and flag the ambiguity in one line.
Keep answers under ~400 words unless enumeration is demanded.`;

/**
 * Question transport: a single-turn Haiku call via agent-sdk; resume continues the dialog.
 * @param {object} [o]
 * @param {string} [o.cwd]       cwd for Haiku sessions (default $READER_WORK_DIR or $TMPDIR/reader-work); created on call
 * @param {object} [o.settings]  settings for query (e.g. {cleanupPeriodDays: 365} — transcript retention period)
 * @param {number} [o.cleanupPeriodDays] shorthand for settings.cleanupPeriodDays
 * @param {string} [o.executable] Claude Code binary (default: resolveClaudeExecutable() on each call)
 * @returns {Function} (prompt, resumeSid, {fork}) → {out, sid}
 */
function createRunQuery({ cwd: cwdOpt, settings, cleanupPeriodDays, executable } = {}) {
  const merged = { ...(settings || {}), ...(cleanupPeriodDays !== undefined ? { cleanupPeriodDays } : {}) };
  const hasSettings = Object.keys(merged).length > 0;
  // fork — branch off the resumeSid session (parallel question to the same document): the base is unchanged.
  return async function runQuery(prompt, resumeSid, { fork = false } = {}) {
    const { query } = require('@anthropic-ai/claude-agent-sdk');
    const cwd = cwdOpt || workDir();
    const exe = executable || resolveClaudeExecutable();
    fs.mkdirSync(cwd, { recursive: true });
    let out = '';
    let sid = resumeSid || null;
    const q = query({
      prompt,
      options: {
        cwd,
        // Do not inherit the user's settings.json: their hooks (including the reader hook itself
        // and Stop hooks that replace the result) must not affect the reader session.
        settingSources: [],
        ...(hasSettings ? { settings: merged } : {}),
        tools: { type: 'preset', preset: 'claude_code' },
        permissionMode: 'default',
        canUseTool: async (n, i) => ({ behavior: 'deny', message: 'reader is read-only' }),
        model: 'haiku',
        allowedTools: [],
        maxTurns: 10,
        ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
        ...(resumeSid ? { resume: resumeSid } : {}),
        ...(resumeSid && fork ? { forkSession: true } : {}),
      },
    });
    for await (const m of q) {
      if (m.session_id) sid = m.session_id;
      if (m.type === 'result') out = m.result || '';
    }
    return { out, sid };
  };
}

const defaultRunQuery = createRunQuery();

// ---- "lines" answer format ----
// Most of the answer latency is generating a long answer (<=400 words + NOTICED), not the prompt
// or tools. An answer of "line ranges + a note of <=40 words" takes ~5–7 s, and the ranges are
// accurate. The line text is filled in by the SERVER from the file (store.peek), so it is verbatim
// by construction: Haiku does not retype or distort code.
const LINES_CAP = 160;   // lines shown verbatim in one answer; the rest are listed as ranges for reader_peek
const LINES_BYTES_CAP = 16 * 1024;   // and bytes: long lines (minified JSON, one-line logs) must not flood the agent's window
const LINE_CHARS_CAP = 2000;         // a longer line is shown by its start, marked as truncated

// NOTICED is not requested in lines mode: scanning the whole document for "anything else suspicious"
// made the first answer take 12–16 s versus 7–9 s without it, while subagents typically ask a document
// a single question right after opening it. Suspicious items can be requested with a separate question.
function linesInstruction() {
  return '\n\nANSWER FORMAT for this question (overrides rule 1 prose and rule 3 — NO NOTICED section in this answer): ONLY one JSON object, no other text:\n'
    + '{"ranges":[[from,to],...],"note":"the direct answer in <=40 words; numbers, identifiers, paths verbatim"}\n'
    + 'ranges = the fewest document lines that answer the question; the agent will see exactly these lines verbatim. '
    + 'If the answer is not in the document: "ranges":[] and say so in note.';
}

// First parseable JSON object in the answer (Haiku sometimes appends text after it).
function extractJson(raw) {
  const s = String(raw || '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  for (let end = s.lastIndexOf('}'); end > start; end = s.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { /* try shorter */ }
  }
  return null;
}

function renderLines(store, entry, raw) {
  const j = extractJson(raw);
  if (!j || !Array.isArray(j.ranges)) return `(answer not in lines format — shown as is)\n${raw}`;
  // Source numbers (lineBase of a Read excerpt with offset): Haiku saw them in numberLines.
  const base = lineBaseOf(entry);
  const last = base + entry.meta.lines - 1;
  const rs = j.ranges
    .map(r => (Array.isArray(r) ? r : [r, r]))
    .map(([a, b]) => [Math.max(base, Math.floor(Number(a))), Math.min(last, Math.floor(Number(b ?? a)))])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a <= b)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of rs) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  let budget = LINES_CAP;
  let bytes = LINES_BYTES_CAP;
  let byBytes = false;
  const parts = [];
  const cut = [];
  for (const [a, b] of merged) {
    if (budget <= 0 || bytes <= 0) { cut.push(`${a}-${b}`); continue; }
    const e = Math.min(b, a + budget - 1);
    // A byte cap too: 160 lines of minified JSON are hundreds of KB in one answer — exactly what
    // the reader exists to keep out of the window. A line longer than LINE_CHARS_CAP is shown by
    // its start with an explicit mark, so it is never passed off as verbatim.
    const kept = [];
    for (const row of store.peek(entry.id, a, e).split('\n')) {
      if (bytes <= 0) { byBytes = true; break; }
      const shown = row.length > LINE_CHARS_CAP
        ? `${row.slice(0, LINE_CHARS_CAP)}… [line truncated: ${row.length - LINE_CHARS_CAP} more chars — reader_peek]` : row;
      kept.push(shown);
      bytes -= Buffer.byteLength(shown, 'utf8') + 1;
    }
    parts.push(kept.join('\n'));
    budget -= kept.length;
    const shownEnd = a + kept.length - 1;
    if (shownEnd < b) cut.push(`${shownEnd + 1}-${b}`);
  }
  let out = j.note ? String(j.note).trim() : '';
  // Ranges were named but none is usable (outside the document, "12-20" instead of [12,20]) — that
  // is not "not in document": the reader's answer is broken, and the agent must see it.
  out += parts.length ? `\n\n${parts.join('\n…\n')}`
    : j.ranges.length ? `\n\n(the reader named lines ${JSON.stringify(j.ranges).slice(0, 120)}, but the document has no such lines — it has lines ${base}–${last}; ask again or use reader_peek)`
      : '\n\n(no lines given — not in document)';
  if (cut.length) out += `\n\n(not shown due to the ${LINES_CAP}-line${byBytes || bytes <= 0 ? ` or ${LINES_BYTES_CAP}-byte` : ''} limit: ${cut.join(', ')} — use reader_peek)`;
  if (Array.isArray(j.noticed)) {
    out += j.noticed.length ? `\n\nNOTICED:\n${j.noticed.map(x => `- ${x}`).join('\n')}` : '\n\nNOTICED: nothing new';
  }
  return out.trim();
}

function numberLines(text, base = 1) {
  return text.split('\n').map((l, i) => `${i + base}\t${l}`).join('\n');
}

/**
 * Ask the reader a question.
 * A single question continues the dialog (entry.lock; the haikuSid session remembers earlier questions).
 * A question that arrives while another one to the same document is in flight runs IN PARALLEL, without
 * queueing: as a fork of the existing session (forkSession) or, if there is no session yet, in its own
 * session with the document. Agents often ask questions in a batch, and queueing them would add up
 * their latencies (e.g. 16 + 6.5 + 8.6 = 31 s).
 * A parallel question does not see its siblings (they were written without each other's answers); the
 * dialog base is changed only by a sequential question — or by a parallel one if there is no base yet.
 * @param {object} store   ReaderStore (for readRaw)
 * @param {object} entry   entry from store.get()
 * @param {string} question
 * @param {Function} [runQuery] transport injection for tests: (prompt, resumeSid, {fork}) → {out, sid}
 * @param {object} [opts] format: 'prose' (connected answer with NOTICED) | 'lines' (verbatim lines + note)
 * @returns {Promise<string>}
 */
async function ask(store, entry, question, runQuery = defaultRunQuery, opts = {}) {
  const lines = opts.format === 'lines';
  const gate = store.canAsk(entry);
  if (!gate.ok) throw new Error(gate.reason);

  const parallel = (entry.inFlight || 0) > 0;
  entry.inFlight = (entry.inFlight || 0) + 1;
  const exec = async () => {
    const base = entry.haikuSid;
    const q = lines ? question + linesInstruction() : question;
    let prompt;
    if (!base) {
      const lb = lineBaseOf(entry);
      const doc = numberLines(store.readRaw(entry.id), lb);
      const note = entry.rehydrated ? '\n(Note: a previous dialog about this document was reset by a server restart.)' : '';
      const span = lb > 1 ? `, source lines ${lb}–${lb + entry.meta.lines - 1}` : '';
      prompt = `${READER_FRAMING}\n\nBRIEFING from the main agent: ${entry.meta.briefing}${note}\n\n--- DOCUMENT ${entry.id} (${entry.meta.lines} lines${span}, ${entry.meta.size} bytes, source: ${entry.meta.source.path || 'inline text'}) ---\n${doc}\n--- END DOCUMENT ---\n\nFirst question: ${q}`;
    } else {
      prompt = q;
    }
    const { out, sid } = await runQuery(prompt, base, { fork: parallel && !!base });
    if (!out) throw new Error('haiku returned an empty answer (transport problem?)');
    // save the session ONLY on success — otherwise the dialog is not "corrupted"
    if (!parallel || !entry.haikuSid) entry.haikuSid = sid;
    entry.rehydrated = false;
    entry.asks++;
    return lines ? renderLines(store, entry, out) : out;
  };
  let run;
  if (parallel) run = exec();
  else {
    run = entry.lock.then(exec);
    // even on error the lock chain must not break for subsequent asks
    entry.lock = run.catch(() => {});
  }
  return run.finally(() => { entry.inFlight--; });
}

module.exports = { ask, createRunQuery, defaultRunQuery, resolveClaudeExecutable, READER_FRAMING, numberLines, renderLines, extractJson, LINES_CAP, LINES_BYTES_CAP, LINE_CHARS_CAP };
