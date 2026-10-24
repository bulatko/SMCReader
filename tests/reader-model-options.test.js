/**
 * Unit: reader model transport options — cwd and settings are passed to the Agent SDK query().
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const calls = [];
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn((args) => {
    calls.push(args);
    return (async function* () { yield { session_id: 'sid-1' }; yield { type: 'result', result: 'ok', session_id: 'sid-1' }; })();
  }),
}));

const { createRunQuery, defaultRunQuery } = require('../lib/reader-model');

let root;
beforeEach(() => { calls.length = 0; root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-model-opt-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('cwd and settings are set by the factory; the directory is created on call', async () => {
  const cwd = path.join(root, 'work');
  const run = createRunQuery({ cwd, settings: { cleanupPeriodDays: 365 } });
  expect(fs.existsSync(cwd)).toBe(false);
  expect(await run('p', null)).toEqual({ out: 'ok', sid: 'sid-1' });
  expect(fs.existsSync(cwd)).toBe(true);
  expect(calls[0].options).toMatchObject({ cwd, settings: { cleanupPeriodDays: 365 }, settingSources: [], model: 'haiku' });
});

test('cleanupPeriodDays shorthand is merged into settings; resume and fork are preserved', async () => {
  await createRunQuery({ cwd: root, settings: { a: 1 }, cleanupPeriodDays: 30 })('p', 'base', { fork: true });
  expect(calls[0].options).toMatchObject({ settings: { a: 1, cleanupPeriodDays: 30 }, resume: 'base', forkSession: true });
});

test('without options — settings are not passed, cwd comes from $READER_WORK_DIR', async () => {
  const prev = process.env.READER_WORK_DIR;
  process.env.READER_WORK_DIR = path.join(root, 'env-work');
  try {
    await defaultRunQuery('p', null);
    expect(calls[0].options.cwd).toBe(path.join(root, 'env-work'));
    expect(calls[0].options).not.toHaveProperty('settings');
  } finally {
    if (prev === undefined) delete process.env.READER_WORK_DIR; else process.env.READER_WORK_DIR = prev;
  }
});
