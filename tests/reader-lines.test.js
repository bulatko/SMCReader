/**
 * Unit tests: the reader's "lines" answer format.
 *
 * Most reader_ask latency goes into generating a long answer. A "line ranges + note" answer takes
 * ~5–7 s. The line text is filled in by the server from the file — verbatim by construction,
 * Haiku does not retype code.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReaderStore } = require('../lib/reader-store');
const haiku = require('../lib/reader-model');

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: jest.fn((o) => ({ type: 'sdk', name: o.name, instance: { tools: o.tools } })),
  tool: jest.fn((name, description, schema, handler) => ({ name, description, schema, handler })),
}));

const DOC = Array.from({ length: 400 }, (_, i) => `line ${i + 1}: const v${i + 1} = ${i * 7};`).join('\n');
let dir; let store; let entry;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-lines-'));
  store = createReaderStore({ dir, log: () => {} });
  const r = store.open({ text: DOC }, 'lines format test');
  entry = store.get(r.id);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const fakeRun = (answer) => {
  const calls = [];
  const fn = async (prompt, sid) => { calls.push({ prompt, sid }); return { out: answer, sid: 'sid-1' }; };
  fn.calls = calls;
  return fn;
};

describe('reader ask format lines', () => {
  test('lines are verbatim from disk, ranges merged, note on top; NOTICED not requested, but shown if present', async () => {
    const run = fakeRun('{"ranges":[[3,4],[4,6],[10,10]],"note":"v3 = 14","noticed":["L7 suspicious zero (L7)"]}');
    const out = await haiku.ask(store, entry, 'what is v3?', run, { format: 'lines' });
    expect(out.startsWith('v3 = 14')).toBe(true);
    expect(out).toContain(store.peek(entry.id, 3, 6));               // 3–6 as one chunk — merged
    expect(out).toContain('\n…\n10\tline 10: const v10 = 63;');
    expect(out).not.toContain('7\tline 7');
    expect(out).toMatch(/NOTICED:\n- L7 suspicious zero/);
    expect(run.calls[0].prompt).not.toContain('"noticed"');           // NOTICED only on request
    expect(run.calls[0].prompt).toContain('NO NOTICED section');
    expect(run.calls[0].prompt).toContain('ANSWER FORMAT');
  });

  test('follow-up (session exists) — instruction without noticed, NOTICED not appended', async () => {
    entry.haikuSid = 'sid-0';
    const run = fakeRun('{"ranges":[[20,21]],"note":"here"}');
    const out = await haiku.ask(store, entry, 'and v20?', run, { format: 'lines' });
    expect(run.calls[0].prompt.startsWith('and v20?')).toBe(true);
    expect(run.calls[0].prompt).not.toContain('"noticed"');
    expect(out).not.toContain('NOTICED');
    expect(out).toContain('20\tline 20: const v20 = 133;');
  });

  test('over the limit — LINES_CAP lines shown, the rest listed as a range for reader_peek', async () => {
    const out = await haiku.ask(store, entry, 'everything', fakeRun('{"ranges":[[1,300]],"note":"a lot"}'), { format: 'lines' });
    expect(out).toContain(`${haiku.LINES_CAP}\tline ${haiku.LINES_CAP}:`);
    expect(out).not.toContain(`${haiku.LINES_CAP + 1}\tline`);
    expect(out).toContain(`(not shown due to the ${haiku.LINES_CAP}-line limit: ${haiku.LINES_CAP + 1}-300 — use reader_peek)`);
  });

  test('ranges past the end of the document are clipped; empty ones give an honest "not in document"', async () => {
    const a = await haiku.ask(store, entry, 'tail', fakeRun('{"ranges":[[399,9999],[0,0]],"note":"end"}'), { format: 'lines' });
    expect(a).toContain('400\tline 400');
    const b = await haiku.ask(store, entry, 'none', fakeRun('{"ranges":[],"note":"not in document"}'), { format: 'lines' });
    expect(b).toContain('(no lines given — not in document)');
  });

  test('JSON with trailing text is parsed; non-JSON — answer as is with a marker', async () => {
    const a = await haiku.ask(store, entry, 'x', fakeRun('{"ranges":[[5,5]],"note":"ok"}\nNOTICED: nothing new'), { format: 'lines' });
    expect(a).toContain('5\tline 5');
    const b = await haiku.ask(store, entry, 'y', fakeRun('Prose answer: v5 = 28 (L5)'), { format: 'lines' });
    expect(b).toBe('(answer not in lines format — shown as is)\nProse answer: v5 = 28 (L5)');
  });

  test('prose (default) — Haiku answer returned unprocessed', async () => {
    const run = fakeRun('v3 = 14 (L3)\nNOTICED: nothing new');
    expect(await haiku.ask(store, entry, 'v3?', run)).toBe('v3 = 14 (L3)\nNOTICED: nothing new');
    expect(run.calls[0].prompt).not.toContain('ANSWER FORMAT');
  });
});

describe('reader_ask: default format from the factory', () => {
  const { createReaderMcpServer } = require('../lib/reader-mcp');
  const askTool = (cfg) => cfg.instance.tools.find(t => t.name === 'reader_ask');
  const spy = () => { const seen = []; return { seen, ask: async (s, e, q, run, opts) => { seen.push(opts); return 'ok'; } }; };

  test('main agent — prose, subagent — lines; explicit format overrides', async () => {
    const h1 = spy();
    await askTool(createReaderMcpServer({ store, haiku: h1 })).handler({ id: entry.id, question: 'q' });
    const h2 = spy();
    const subagentTool = askTool(createReaderMcpServer({ store, haiku: h2, askFormat: 'lines' }));
    await subagentTool.handler({ id: entry.id, question: 'q' });
    await subagentTool.handler({ id: entry.id, question: 'q', format: 'prose' });
    expect(h1.seen).toEqual([{ format: 'prose' }]);
    expect(h2.seen).toEqual([{ format: 'lines' }, { format: 'prose' }]);
  });
});

// Agents often ask a document several questions in a batch; queueing them would add up their latencies.
describe('parallel questions to one document', () => {
  const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
  const slowRun = (g, answer, sid) => {
    const calls = [];
    const fn = async (prompt, base, o) => { calls.push({ prompt, base, fork: !!(o && o.fork) }); await g.p; return { out: answer, sid }; };
    fn.calls = calls; return fn;
  };

  test('no session yet: the second question does not wait for the first — own session with the document', async () => {
    const g = gate();
    const r1 = slowRun(g, '{"ranges":[[1,1]],"note":"a"}', 'sid-a');
    const r2 = slowRun(g, '{"ranges":[[2,2]],"note":"b"}', 'sid-b');
    const p1 = haiku.ask(store, entry, 'q1', r1, { format: 'lines' });
    const p2 = haiku.ask(store, entry, 'q2', r2, { format: 'lines' });
    await new Promise(r => setImmediate(r));
    expect(r1.calls).toHaveLength(1);
    expect(r2.calls).toHaveLength(1);                                 // sent without waiting for the first
    expect(r2.calls[0].prompt).toContain('--- DOCUMENT');
    expect(r2.calls[0].fork).toBe(false);
    g.open(); await Promise.all([p1, p2]);
    expect(entry.haikuSid).toBe('sid-a');                             // the sequential one sets the base
    expect(entry.inFlight).toBe(0);
  });

  test('session exists: a parallel question forks the base; the dialog base is unchanged', async () => {
    entry.haikuSid = 'base';
    const g = gate();
    const r1 = slowRun(g, '{"ranges":[[1,1]],"note":"a"}', 'base-next');
    const r2 = slowRun(g, '{"ranges":[[2,2]],"note":"b"}', 'fork-1');
    const p1 = haiku.ask(store, entry, 'q1', r1, { format: 'lines' });
    const p2 = haiku.ask(store, entry, 'q2', r2, { format: 'lines' });
    await new Promise(r => setImmediate(r));
    expect(r1.calls[0]).toMatchObject({ base: 'base', fork: false });
    expect(r2.calls[0]).toMatchObject({ base: 'base', fork: true });
    expect(r2.calls[0].prompt.startsWith('q2')).toBe(true);           // follow-up, no document
    g.open(); await Promise.all([p1, p2]);
    expect(entry.haikuSid).toBe('base-next');                         // continued by the sequential one, not the fork
    const r3 = fakeRun('{"ranges":[[3,3]],"note":"c"}');
    await haiku.ask(store, entry, 'q3', r3, { format: 'lines' });
    expect(r3.calls[0].sid).toBe('base-next');                        // a single question — dialog again
  });

  test('a failed parallel question does not leave the counter stuck and does not corrupt the base', async () => {
    entry.haikuSid = 'base';
    const g = gate();
    const p1 = haiku.ask(store, entry, 'q1', slowRun(g, '{"ranges":[[1,1]],"note":"a"}', 'base-2'), { format: 'lines' });
    const p2 = haiku.ask(store, entry, 'q2', async () => { throw new Error('transport'); }, { format: 'lines' });
    await expect(p2).rejects.toThrow('transport');
    g.open(); await p1;
    expect(entry.inFlight).toBe(0);
    expect(entry.haikuSid).toBe('base-2');
  });
});
