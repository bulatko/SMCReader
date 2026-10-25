/**
 * Unit tests: the reader's answers stay honest and bounded.
 *
 * - the per-document question limit holds for a parallel batch;
 * - line numbers of an intercepted Read are FILE line numbers (pointer, peek, lines answer);
 * - a lines answer with named but unusable ranges says so instead of "not in document";
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReaderStore } = require('../lib/reader-store');
const haiku = require('../lib/reader-model');
const { createInterceptHook } = require('../lib/intercept-hook');

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: jest.fn((o) => ({ type: 'sdk', name: o.name, instance: { tools: o.tools } })),
  tool: jest.fn((name, description, schema, handler) => ({ name, description, schema, handler })),
}));

const FILE = Array.from({ length: 470 }, (_, i) => `orig line ${i + 1}`);
let dir; let store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-integrity-'));
  store = createReaderStore({ dir, log: () => {} });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// asks grows only when a question completes; parallel questions used to pass canAsk together.
test('the question limit holds for a parallel batch', async () => {
  const r = store.open({ text: FILE.join('\n') }, 'limit');
  const entry = store.get(r.id);
  entry.asks = store.limits.MAX_ASKS - 1;
  let release;
  const gate = new Promise((res) => { release = res; });
  const run = async () => { await gate; return { out: 'answer', sid: 's' }; };
  const p = Array.from({ length: 4 }, () => haiku.ask(store, entry, 'q', run).then(() => 'ok', (e) => e.message));
  release();
  const got = await Promise.all(p);
  expect(got.filter((x) => x === 'ok')).toHaveLength(1);
  expect(got.filter((x) => /ask limit/.test(x))).toHaveLength(3);
  expect(entry.asks).toBe(store.limits.MAX_ASKS);
});

// The engine numbers a Read replacement like cat -n from file.startLine. A [READER] header on top
// shifted file line K to K+1; a tail after "… omitted …" got numbers that are not in the file; for an
// excerpt Read(offset=219) reader_peek(id, 1, 1) returned file line 219. Agents edited by these numbers.
describe('intercepted Read keeps file line numbers', () => {
  let hook;
  beforeEach(() => { hook = createInterceptHook({ store, threshold: 1024, allowlist: ['Read', 'Bash'], log: () => {} }); });
  const readResponse = (startLine, lines) => ({ type: 'text', file: {
    filePath: '/x/app.js', content: lines.join('\n'), numLines: lines.length, startLine, totalLines: FILE.length } });
  const pointerOf = (out) => out.hookSpecificOutput.updatedToolOutput.file.content;
  const idOf = (p) => p.match(/\[READER (ctx_\w+)\]/)[1];
  const shown = (p, startLine) => p.split('\n').map((l, i) => [startLine + i, l]);   // how the engine numbers it
  const fileRows = (p, startLine) => shown(p, startLine).filter(([, l]) => /^orig line \d+$/.test(l));

  test('full Read: every line shown with a number is the file line with that number; no tail', async () => {
    const p = pointerOf(await hook({ tool_name: 'Read', tool_input: { file_path: '/x/app.js' }, tool_response: readResponse(1, FILE.slice(0, 160)) }));
    expect(fileRows(p, 1).length).toBeGreaterThan(0);
    for (const [n, l] of fileRows(p, 1)) expect(l).toBe(`orig line ${n}`);
    expect(p).not.toContain('orig line 160');
    expect(p).toMatch(/file lines 1–160/);
  });

  test('Read(offset=219): pointer, peek and the lines answer use file numbers', async () => {
    const p = pointerOf(await hook({ tool_name: 'Read', tool_input: { file_path: '/x/app.js', offset: 219, limit: 252 },
      tool_response: readResponse(219, FILE.slice(218, 470)) }));
    for (const [n, l] of fileRows(p, 219)) expect(l).toBe(`orig line ${n}`);
    expect(p).toMatch(/file lines 219–470/);
    const id = idOf(p);
    expect(store.peek(id, 219, 219)).toBe('219\torig line 219');
    expect(store.peek(id, 300, 301)).toBe('300\torig line 300\n301\torig line 301');
    expect(store.peek(id, 1, 1)).toBe('219\torig line 219');   // clamped to the excerpt

    const calls = [];
    const run = async (prompt) => { calls.push(prompt); return { out: '{"ranges":[[300,301]],"note":"here"}', sid: 's1' }; };
    const ans = await haiku.ask(store, store.get(id), 'where is 300?', run, { format: 'lines' });
    expect(calls[0]).toContain('300\torig line 300');           // Haiku sees file numbers
    expect(calls[0]).toContain('source lines 219–470');
    expect(ans).toContain('300\torig line 300\n301\torig line 301');
  });

  test('non-Read output is unchanged: header on top, head/tail, numbers from 1', async () => {
    const out = await hook({ tool_name: 'Bash', tool_input: { command: 'seq' }, tool_response: { stdout: FILE.join('\n'), stderr: '' } });
    const p = out.hookSpecificOutput.updatedToolOutput.stdout;
    expect(p.startsWith('[READER ')).toBe(true);
    expect(p).toContain('lines omitted');
    expect(store.peek(idOf(p), 1, 1)).toBe('1\torig line 1');
  });
});

// Haiku sometimes answers ["12-20"] instead of [12,20] or misses the document: the ranges were
// dropped silently and the agent read "not in document" — and concluded the thing is absent.
test('lines answer: named but unusable ranges are reported, not "not in document"', async () => {
  const r = store.open({ text: FILE.slice(0, 50).join('\n') }, 'ranges');
  const bad = async () => ({ out: '{"ranges":[["12-20"],[900,950]],"note":"see lines"}', sid: 's' });
  const ans = await haiku.ask(store, store.get(r.id), 'where?', bad, { format: 'lines' });
  expect(ans).not.toContain('not in document');
  expect(ans).toMatch(/the document has no such lines — it has lines 1–50/);
  const empty = async () => ({ out: '{"ranges":[],"note":"no such thing"}', sid: 's' });
  expect(await haiku.ask(store, store.get(r.id), 'and this?', empty, { format: 'lines' })).toContain('(no lines given — not in document)');
});
