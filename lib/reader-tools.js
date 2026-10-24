/**
 * reader-tools — transport-agnostic reader tools: reader_open/ask/peek/close/list
 * as plain {name, description, schema, handler}.
 *
 * schema is a zod "raw shape" (an object of fields), understood the same way by both adapters:
 * stdio MCP (@modelcontextprotocol/sdk, lib/stdio-mcp.js) and the in-process Agent SDK MCP
 * (createSdkMcpServer, lib/reader-mcp.js). handler(args) → {content:[{type:'text',text}]}.
 * Errors are not thrown: the agent gets "Error: …" as text, like any tool output.
 */

'use strict';

const { z } = require('zod');
const readerModel = require('./reader-model');

/** Tool names in Claude Code when the server is named "reader" — for allowedTools. */
const READER_TOOL_NAMES = [
  'mcp__reader__reader_open',
  'mcp__reader__reader_ask',
  'mcp__reader__reader_peek',
  'mcp__reader__reader_close',
  'mcp__reader__reader_list',
];

const readerText = (text) => ({ content: [{ type: 'text', text }] });
const readerErr = (e) => readerText(`Error: ${e.message}`);

/**
 * reader_open description. The extra "also NOT for this" clause is a parameter: it depends
 * on the agent's environment (some have a separate transcript reader, some don't).
 */
const openDescription = (alsoNotFor) =>
  'Open a document in a persistent haiku-powered reader WITHOUT loading it into your context. ' +
  'Use for: large files (logs, long sources, datasets), long command outputs (pass as {text}), ' +
  'anything you will question repeatedly. Do NOT use for small files you are about to Edit ' +
  `(use Read — you need exact bytes)${alsoNotFor ? ` or ${alsoNotFor}` : ''}. ` +
  'Returns id + stats + head/tail preview; then interrogate with reader_ask, verify exact values with reader_peek.';

const evictedNote = (store, r) => {
  // The wording is SHARED with the interception pointer (intercept-hook.js): the agent
  // should not have to care which path opened the document.
  const cap = store.limits && store.limits.MAX_OPEN;
  return r.evicted
    ? `\n(evicted ${r.evicted}${cap ? ` — ${cap}/${cap} open` : ' — reader limit reached'}; close with mcp__reader__reader_close)`
    : '';
};

/**
 * @param {object} opts
 * @param {object} opts.store            ReaderStore (lib/reader-store.js)
 * @param {object} [opts.haiku]          question transport {ask} (injected in tests)
 * @param {string} [opts.openAlsoNotFor] tail of the "Do NOT use for …" clause in reader_open
 * @param {string} [opts.owner]          document owner (session id); unset — all documents are visible
 * @param {'prose'|'lines'} [opts.askFormat] default reader_ask format
 * @returns {Array<{name, description, schema, handler}>}
 */
function createReaderTools({ store, haiku = readerModel, openAlsoNotFor = '', owner, askFormat = 'prose' } = {}) {
  if (!store) throw new Error('createReaderTools requires {store}');
  const own = owner !== undefined ? { owner } : {};
  return [
    {
      name: 'reader_open',
      description: openDescription(openAlsoNotFor),
      schema: {
        path: z.string().optional().describe('Absolute file path. Exactly one of path|text.'),
        text: z.string().optional().describe('Inline text to open (e.g. a big command output you want kept out of your context).'),
        briefing: z.string().describe('Why you are opening this and what matters — the reader prioritizes by it. Name what to watch for (errors? a function? specific numbers?).'),
      },
      handler: async (args) => {
        try {
          const r = store.open(args.path !== undefined ? { path: args.path } : { text: args.text }, args.briefing, own);
          const warn = r.tooLargeForAsk ? '\nNOTE: too large for reader_ask — use reader_peek/Grep.' : '';
          return readerText(`Opened ${r.id} (${r.lines} lines, ${r.size} bytes).${warn}${evictedNote(store, r)}\nPreview:\n${r.preview}`);
        } catch (e) { return readerErr(e); }
      },
    },
    {
      name: 'reader_ask',
      description: askFormat === 'lines'
        ? 'Ask the haiku reader a question about an open document. The reader remembers the dialog: follow-up questions are cheap. '
          + 'Default answer (format "lines"): a short direct answer + the document lines that answer it, VERBATIM from disk (exact bytes — fit for Edit), ~6–9 s. '
          + 'Several questions to one document at once run in parallel. Errors/anomalies you did not ask about are NOT listed in lines — ask for them explicitly '
          + '("what looks suspicious here?") or use format "prose" — a connected explanation with line citations and a NOTICED section (slower).'
        : 'Ask the haiku reader a question about an open document. Answers cite line numbers and ALWAYS end with a NOTICED section (errors/anomalies/secrets you did not ask about — read it). The reader remembers the dialog: follow-up questions are cheap. Confirm critical exact values via reader_peek.',
      schema: {
        id: z.string().describe('Reader id from reader_open (ctx_...).'),
        question: z.string().describe('One specific question per ask.'),
        // The format parameter exists only where lines is the default: the prose description and schema stay unchanged.
        ...(askFormat === 'lines' ? { format: z.enum(['lines', 'prose']).optional().describe('Answer format (default "lines"): "lines" — relevant document lines verbatim + short note; "prose" — explanation with citations.') } : {}),
      },
      handler: async (args) => {
        try {
          const entry = store.get(args.id);
          if (!entry) return readerText(`Error: no reader '${args.id}'. reader_list shows open readers.`);
          return readerText(await haiku.ask(store, entry, args.question, undefined, { format: args.format || askFormat }));
        } catch (e) { return readerErr(e); }
      },
    },
    {
      name: 'reader_peek',
      description: 'Verbatim numbered slice of an open document — no LLM, exact bytes from disk. Use to ground-check a reader_ask claim or pull an exact value/snippet. Max 400 lines per call.',
      // start/end are aliases, not a typo: agents write "reader_peek(id, start, end)", and
      // numeric strings ("9", not 9) are no reason to reject the call, hence coerce.
      schema: {
        id: z.string(),
        start_line: z.coerce.number().int().min(1).optional().describe('First line, 1-based. Required (alias: start).'),
        end_line: z.coerce.number().int().min(1).optional().describe('Last line, inclusive. Required (alias: end).'),
        start: z.coerce.number().int().min(1).optional().describe('Alias of start_line.'),
        end: z.coerce.number().int().min(1).optional().describe('Alias of end_line.'),
      },
      handler: async (args) => {
        const startLine = args.start_line ?? args.start;
        const endLine = args.end_line ?? args.end;
        if (startLine === undefined || endLine === undefined) {
          return readerText('Error: reader_peek needs start_line and end_line (1-based, inclusive), e.g. {id, start_line: 1, end_line: 50}.');
        }
        try { return readerText(store.peek(args.id, startLine, endLine)); } catch (e) { return readerErr(e); }
      },
    },
    {
      name: 'reader_close',
      description: 'Close a reader and delete its spilled raw file. Call when done — max 10 readers may be open.',
      schema: { id: z.string() },
      handler: async (args) => {
        try {
          const existed = store.close(args.id, own);
          return readerText(existed ? `Closed ${args.id}.` : `${args.id} was not open (already closed?).`);
        } catch (e) { return readerErr(e); }
      },
    },
    {
      name: 'reader_list',
      description: 'List open readers (id, size, briefing, ask count). Use when unsure what is open or before opening near the limit of 10.',
      schema: {},
      handler: async () => {
        try {
          const l = store.list(own);
          return readerText(l.length ? JSON.stringify(l, null, 2) : 'No open readers.');
        } catch (e) { return readerErr(e); }
      },
    },
  ];
}

module.exports = { createReaderTools, READER_TOOL_NAMES, openDescription };
