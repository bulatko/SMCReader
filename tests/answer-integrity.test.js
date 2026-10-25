/**
 * Unit tests: the reader's answers stay honest and bounded.
 *
 * - the per-document question limit holds for a parallel batch;
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
