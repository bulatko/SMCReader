/**
 * Unit: hook command body (lib/hook-command.js) — config from env, owner from session_id,
 * fail-open, Read guard via $READER_READ_GUARD.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Writable } = require('stream');
const { handleHookInput, main } = require('../lib/hook-command');
const { loadConfig } = require('../lib/config');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-hookcmd-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const big = (n = 600) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
const bash = (stdout, extra = {}) => ({
  session_id: 'S1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make' },
  tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, ...extra,
});
const metaOf = (out) => {
  const id = /\[READER (ctx_[0-9a-f]{8})\]/.exec(out.hookSpecificOutput.updatedToolOutput.stdout)[1];
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.meta.json`), 'utf8'));
};

test('config: defaults and overrides from env', () => {
  const d = loadConfig({ HOME: '/home/u' });
  expect(d.threshold).toBe(2048);
  expect(d.allowlist).toEqual(['Bash', 'WebFetch']);
  expect(d.askFormat).toBe('lines');
  expect(d.readGuard).toBe(0);
  expect(loadConfig({ XDG_CACHE_HOME: '/c' }).dir).toBe('/c/smcreader');
  expect(loadConfig({ HOME: '/home/u' }).dir).toBe(path.join(os.homedir(), '.cache', 'smcreader'));
  const o = loadConfig({ READER_DIR: '/x', READER_THRESHOLD: '100', READER_ALLOWLIST: 'Bash, mcp__a__b', READER_ASK_FORMAT: 'prose', READER_THRESHOLD_BAD: 1 });
  expect(o).toMatchObject({ dir: '/x', threshold: 100, allowlist: ['Bash', 'mcp__a__b'], askFormat: 'prose' });
  expect(loadConfig({ READER_THRESHOLD: 'abc' }).threshold).toBe(2048);
});

test('document owner is session_id; a subagent gets a child of the session', async () => {
  const env = { READER_DIR: dir };
  expect(metaOf(await handleHookInput(bash(big()), env)).owner).toBe('S1');
  expect(metaOf(await handleHookInput(bash(big(), { agent_id: 'ag1' }), env)).owner).toBe('S1/agent:ag1');
  expect(metaOf(await handleHookInput(bash(big(), { session_id: undefined }), { ...env, READER_OWNER: 'fallback' })).owner).toBe('fallback');
});

test('threshold and allowlist from env', async () => {
  const env = { READER_DIR: dir, READER_THRESHOLD: '100000' };
  expect(await handleHookInput(bash(big()), env)).toEqual({});
  const mcp = { ...bash(''), tool_name: 'mcp__x__y', tool_response: { content: [{ type: 'text', text: big() }] } };
  expect(await handleHookInput(mcp, { READER_DIR: dir })).toEqual({});
  const out = await handleHookInput(mcp, { READER_DIR: dir, READER_ALLOWLIST: 'mcp__x__y' });
  expect(out.hookSpecificOutput.updatedToolOutput.content[0].text).toMatch(/^\[READER ctx_[0-9a-f]{8}\] mcp__x__y output intercepted/);
});

test('fail-open: store cannot be created (directory is a file) → empty response', async () => {
  const file = path.join(dir, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  expect(await handleHookInput(bash(big()), { READER_DIR: path.join(file, 'sub') })).toEqual({});
  expect(await handleHookInput(null, { READER_DIR: dir })).toEqual({});
  expect(await handleHookInput(bash(big(), { hook_event_name: 'Stop' }), { READER_DIR: dir })).toEqual({});
});

test('main: garbage on stdin → nothing on stdout, code 0; valid input → replacement JSON', async () => {
  const run = async (input) => {
    let written = '';
    const stdout = new Writable({ write(c, _e, cb) { written += c; cb(); } });
    const code = await main({ stdin: Readable.from([input]), stdout, env: { READER_DIR: dir } });
    return { code, written };
  };
  expect(await run('{not json')).toEqual({ code: 0, written: '' });
  const ok = await run(JSON.stringify(bash(big())));
  expect(ok.code).toBe(0);
  expect(JSON.parse(ok.written).hookSpecificOutput.hookEventName).toBe('PostToolUse');
});

test('Read guard: off by default; with $READER_READ_GUARD a full Read of a large file is denied', async () => {
  const f = path.join(dir, 'big.txt');
  fs.writeFileSync(f, big(5000));
  const read = { session_id: 'S1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: f } };
  expect(await handleHookInput(read, { READER_DIR: dir })).toEqual({});
  const out = await handleHookInput(read, { READER_DIR: dir, READER_READ_GUARD: '4096' });
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(out.hookSpecificOutput.permissionDecisionReason).toContain('mcp__reader__reader_open');
  expect(await handleHookInput({ ...read, tool_input: { file_path: f, limit: 10 } }, { READER_DIR: dir, READER_READ_GUARD: '4096' })).toEqual({});
});

test('READER_TOOL_PREFIX: the pointer hint names tools as the model sees them (plugin)', async () => {
  const P = 'mcp__plugin_smcreader_smcreader__';
  const out = await handleHookInput(bash(big()), { READER_DIR: dir, READER_TOOL_PREFIX: P });
  const ptr = out.hookSpecificOutput.updatedToolOutput.stdout;
  expect(ptr.split('\n').pop()).toMatch(new RegExp(`^Full output is in reader ctx_[0-9a-f]{8}: ${P}reader_ask\\(id, question\\) to analyze, ${P}reader_peek\\(`));
  expect(ptr).not.toContain('mcp__reader__');
  // without the variable — default text; a malformed value is ignored
  const dflt = (await handleHookInput(bash(big()), { READER_DIR: dir })).hookSpecificOutput.updatedToolOutput.stdout;
  expect(dflt).toContain(': mcp__reader__reader_ask(id, question)');
  const junk = (await handleHookInput(bash(big()), { READER_DIR: dir, READER_TOOL_PREFIX: 'a b;rm' })).hookSpecificOutput.updatedToolOutput.stdout;
  expect(junk).toContain(': mcp__reader__reader_ask(id, question)');
});
