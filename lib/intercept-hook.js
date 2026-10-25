/**
 * intercept-hook — PostToolUse hook that intercepts LARGE tool outputs before
 * they reach the main agent's context and replaces them with a "lazy pointer":
 * a compact header + head/tail + reader_id.
 *
 * Haiku is NOT called at interception time (zero latency, zero cost) — the
 * actual reading happens lazily, when the agent calls reader_ask with a
 * question it already has (pull model).
 *
 * Fail-safe: any failure inside the hook → return {} (output passes through as is).
 * Losing compression is cheap; blinding the agent is expensive.
 */

const DEFAULT_THRESHOLD = 2048; // chars; ~500 tokens
const HEAD_LINES = 8;
const TAIL_LINES = 4;
const POINTER_BODY_CAP = 900; // chars for head+tail in the pointer

/** Tools whose outputs are intercepted by default. Deliberately NOT: Read (exact bytes
 *  for Edit), Agent/Task (already summaries), mcp__reader__* (recursion). MCP tools —
 *  only via an explicit allowlist ($READER_ALLOWLIST): each has its own output shape. */
const DEFAULT_ALLOWLIST = ['Bash', 'WebFetch'];

/**
 * Extract text from tool_response + classify its SHAPE. The shape is critical:
 * the engine applies updatedToolOutput only if the replacement structurally matches
 * what the tool returned (otherwise "does not match output shape" → original is kept).
 * shape ∈ {string, stdout, content, output, array, file} — supported for replacement;
 * 'unknown' → skip interception (fail-open).
 */
function extractText(toolResponse) {
  if (typeof toolResponse === 'string') return { text: toolResponse, shape: 'string' };
  if (toolResponse == null) return { text: '', shape: 'unknown' };
  if (typeof toolResponse === 'object') {
    if (typeof toolResponse.stdout === 'string') { // Bash: {stdout,stderr,interrupted,isImage,...}
      const err = typeof toolResponse.stderr === 'string' && toolResponse.stderr.trim()
        ? `\n--- stderr ---\n${toolResponse.stderr}` : '';
      return { text: toolResponse.stdout + err, shape: 'stdout' };
    }
    if (Array.isArray(toolResponse.content)) { // MCP: {content:[{type:'text',text}]}
      const text = toolResponse.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text).join('\n');
      if (text) return { text, shape: 'content' };
    }
    if (typeof toolResponse.output === 'string') return { text: toolResponse.output, shape: 'output' };
    // Read: {type:'text', file:{filePath, content, numLines, startLine, totalLines}}.
    // Without this shape, interception silently failed open on EVERY Read, and large
    // file contents went into the context in full.
    if (toolResponse.file && typeof toolResponse.file.content === 'string') {
      return { text: toolResponse.file.content, shape: 'file' };
    }
    // MCP output as a bare array of content blocks: [{type:'text',text}, ...]
    // (some MCP servers return this; Object.keys of the array = ['0','1',...]).
    if (Array.isArray(toolResponse)) {
      const text = toolResponse
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text).join('\n');
      if (text) return { text, shape: 'array' };
    }
  }
  return { text: '', shape: 'unknown' }; // can't mirror this shape — don't intercept
}

/**
 * Build the replacement in the SAME shape the tool returned, substituting the pointer.
 * Other fields (interrupted, isImage, ...) are preserved; stderr is cleared.
 */
function buildReplacement(toolResponse, shape, pointer) {
  switch (shape) {
    case 'string': return pointer;
    case 'stdout': return { ...toolResponse, stdout: pointer, stderr: '' };
    case 'content': return { ...toolResponse, content: [{ type: 'text', text: pointer }] };
    case 'output': return { ...toolResponse, output: pointer };
    // Other file fields (filePath/numLines/…) are kept: the engine checks the shape,
    // and the agent benefits from seeing WHAT was moved to the reader.
    case 'file': return { ...toolResponse, file: { ...toolResponse.file, content: pointer } };
    case 'array': return [{ type: 'text', text: pointer }]; // array of content blocks — mirror as an array
    default: return null;
  }
}

function headTail(text) {
  const lines = text.split('\n');
  if (lines.length <= HEAD_LINES + TAIL_LINES) {
    // Few lines, but the text may be huge (minified JSON, single-line log):
    // use character head+tail so the tail (exit code, last error) is not lost.
    if (text.length <= POINTER_BODY_CAP) return text;
    const headChars = Math.floor(POINTER_BODY_CAP * 0.7);
    const tailChars = POINTER_BODY_CAP - headChars;
    return `${text.slice(0, headChars)}\n... (${text.length - headChars - tailChars} chars omitted — in the reader) ...\n${text.slice(-tailChars)}`;
  }
  const head = lines.slice(0, HEAD_LINES).join('\n');
  const tail = lines.slice(-TAIL_LINES).join('\n');
  let body = `${head}\n... (${lines.length - HEAD_LINES - TAIL_LINES} lines omitted — in the reader) ...\n${tail}`;
  if (body.length > POINTER_BODY_CAP) body = body.slice(0, POINTER_BODY_CAP) + '…';
  return body;
}

/**
 * Head of an intercepted Read: whole file lines only, as is. The engine numbers the replacement
 * like cat -n starting at file.startLine, so file lines must come first — a [READER] header on top
 * shifted every number by +1, and a tail after "… omitted …" got numbers that are not in the file
 * (the last line of a 160-line file was shown as line 14). Agents edit by these numbers.
 */
function fileHead(text) {
  const out = [];
  let size = 0;
  for (const l of text.split('\n').slice(0, HEAD_LINES)) {
    if (size + l.length + 1 > POINTER_BODY_CAP) break;
    out.push(l);
    size += l.length + 1;
  }
  return out;
}

function describeInput(toolName, toolInput) {
  try {
    if (toolName === 'Bash' && toolInput?.command) return toolInput.command.slice(0, 200);
    if (toolName === 'WebFetch' && toolInput?.url) return toolInput.url.slice(0, 200);
    if (toolInput?.command) return String(toolInput.command).slice(0, 200);
    return JSON.stringify(toolInput).slice(0, 200);
  } catch (_) { return '(unprintable input)'; }
}

/**
 * Factory for the PostToolUse callback.
 * @param {object} opts
 * @param {object} opts.store      ReaderStore
 * @param {number} [opts.threshold]
 * @param {string[]} [opts.allowlist]
 * @param {Function} [opts.log]
 */
// owner — id of the session that owns intercepted documents (shared store of the main agent).
// taskContext() — the agent's task, used in the reader briefing.
// askHint(id) — last line of the pointer: how to work with the reader.
function createInterceptHook({ store, threshold = DEFAULT_THRESHOLD, allowlist = DEFAULT_ALLOWLIST, log = console.log, owner,
  taskContext = null, askHint = null } = {}) {
  if (!store) throw new Error('createInterceptHook requires {store}');
  const allowed = new Set(allowlist);

  return async function postToolUseIntercept(input /*, toolUseID, { signal } */) {
    try {
      const toolName = input?.tool_name;
      if (!toolName || !allowed.has(toolName)) return {};
      // Claude Code already moved a big output to a file: tool_response holds a stdout truncated to
      // BASH_MAX_OUTPUT_LENGTH plus persistedOutputPath, and the model gets a preview with the path.
      // Intercepting it would store the truncated text and put our pointer in place of that preview.
      if (input.tool_response && typeof input.tool_response === 'object' && input.tool_response.persistedOutputPath) return {};

      const { text, shape } = extractText(input.tool_response);
      if (!text || text.length < threshold) return {};
      if (shape === 'unknown') return {}; // shape can't be mirrored → skip (the engine would reject the replacement)

      const inputDesc = describeInput(toolName, input.tool_input);
      let task = null;
      try { task = typeof taskContext === 'function' ? taskContext() : null; } catch (_) { task = null; }
      const why = input.tool_input && typeof input.tool_input.description === 'string' ? input.tool_input.description.trim() : '';
      // The task and the call description give the reader a goal: without them the briefing
      // is a generic "look for errors" template, and the reader has nothing to judge
      // "what matters here" against.
      const briefing = `Intercepted output of ${toolName} (${inputDesc}).`
        + (task ? ` The agent's task: ${String(task).slice(0, 600)}.` : '')
        + (why ? ` Its own description of this call: ${why.slice(0, 300)}.` : '')
        + ` The main agent saw only a head/tail pointer and will ask about specifics. Watch for: errors, warnings, anomalies, unexpected values${task ? ', and whatever matters for the task' : ''}.`;
      // The hook also fires for subagent tools (Agent/Task) — the SDK sets agent_id for them.
      // Under the session owner, their outputs would consume the session's reader limit and
      // evict its documents. A subagent gets its own child owner: its own limit and LRU;
      // the session can still close them.
      const docOwner = input.agent_id
        ? `${owner !== undefined ? `${owner}/` : ''}agent:${input.agent_id}`
        : owner;
      // A Read excerpt (offset) starts at file line startLine: the reader (peek, ask) keeps FILE
      // numbers, not excerpt numbers.
      const fileStart = shape === 'file' ? input.tool_response.file.startLine : 1;
      const startLine = Number.isInteger(fileStart) && fileStart > 1 ? fileStart : 1;
      const r = store.open({ text }, briefing, {
        tool_name: toolName,
        tool_input: inputDesc,
        ...(docOwner !== undefined ? { owner: docOwner } : {}),
        ...(startLine > 1 ? { lineBase: startLine } : {}),
      });

      // Eviction MUST be visible right here: the pointer is the only thing the agent
      // reads. It doesn't see the store's server log, and a silently lost document
      // looks to it like "the reader lied".
      const cap = store.limits && store.limits.MAX_OPEN;
      const evictedNote = r.evicted
        ? `\n(evicted ${r.evicted}${cap ? ` — ${cap}/${cap} open` : ' — reader limit reached'}; close with mcp__reader__reader_close)`
        : '';
      const hint = typeof askHint === 'function' ? askHint(r.id)
        : `Full output is in reader ${r.id}: mcp__reader__reader_ask(id, question) to analyze, reader_peek(id, start_line, end_line) for exact lines, reader_close(id) when done.`;
      let pointer;
      if (shape === 'file') {
        // File lines first, at their real numbers; then one [READER] line that says the numbering
        // stops being file numbering from here. No tail: it would get numbers that are not in the file.
        const head = fileHead(text);
        const last = startLine + r.lines - 1;
        const hidden = startLine + head.length;
        pointer = (head.length ? `${head.join('\n')}\n` : '')
          + `[READER ${r.id}] ${toolName} output intercepted: ${r.size} bytes, file lines ${startLine}–${last} (>${threshold} chars).${evictedNote} `
          + (head.length ? `Above: file lines ${startLine}–${hidden - 1} verbatim, real numbers. ` : '')
          + (hidden <= last ? `From this line on the numbers are NOT file lines. Lines ${hidden}–${last} are in the reader; reader_peek takes file line numbers.\n` : '\n')
          + hint;
      } else {
        pointer =
          `[READER ${r.id}] ${toolName} output intercepted: ${r.size} bytes, ${r.lines} lines (>${threshold} chars).${evictedNote}\n` +
          `${headTail(text)}\n` + hint;
      }

      // The replacement MUST match the tool's shape — otherwise the engine silently keeps the original.
      const replacement = buildReplacement(input.tool_response, shape, pointer);
      if (replacement === null) return {}; // safety net

      log(`[reader-hook] intercepted ${toolName} output: ${text.length} chars (shape=${shape}) -> ${r.id}`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: replacement,
        },
      };
    } catch (e) {
      // fail-open: never break output delivery
      try { log(`[reader-hook] error (passing output through): ${e.message}`); } catch (_) {}
      return {};
    }
  };
}

module.exports = { createInterceptHook, extractText, buildReplacement, headTail, DEFAULT_ALLOWLIST, DEFAULT_THRESHOLD };
