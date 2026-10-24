/**
 * Cross-process: the hook command and the MCP server are separate processes over one $READER_DIR.
 * A SEPARATE process (bin/reader-hook with stdin) writes the document; the server (bin/reader-mcp,
 * also a separate process, over stdio MCP) sees it: list, peek, close; another owner
 * cannot close it; the open limit and eviction count documents from both processes.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'bin', 'reader-hook');
const MCP = path.join(ROOT, 'bin', 'reader-mcp');
const SEQ = Array.from({ length: 3000 }, (_, i) => String(i + 1)).join('\n') + '\n';

jest.setTimeout(30000);

let dir;
const clients = [];
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-xproc-')); });
afterEach(async () => {
  while (clients.length) { try { await clients.pop().close(); } catch (_) { /* */ } }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Run bin/reader-hook as a separate process; return {pointer, id, raw}. */
function runHook(sessionId, stdout = SEQ, extra = {}) {
  const input = {
    session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_x',
    tool_input: { command: 'seq 1 3000' }, cwd: dir, transcript_path: '/dev/null', permission_mode: 'default',
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
    ...extra,
  };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { ...process.env, READER_DIR: dir }, encoding: 'utf8' });
  expect(r.status).toBe(0);
  const out = r.stdout ? JSON.parse(r.stdout) : {};
  const pointer = out.hookSpecificOutput ? out.hookSpecificOutput.updatedToolOutput.stdout : '';
  const m = /\[READER (ctx_[0-9a-f]{8})\]/.exec(pointer);
  return { pointer, id: m ? m[1] : null, out };
}

/** Start bin/reader-mcp as a separate process and connect to it over stdio. */
async function server(owner) {
  const env = { ...process.env, READER_DIR: dir };
  if (owner) env.READER_OWNER = owner; else delete env.READER_OWNER;
  const c = new Client({ name: 'xproc-test', version: '0' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env, stderr: 'pipe' }));
  clients.push(c);
  const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).content[0].text;
  return { call, list: async () => { const t = await call('reader_list'); return t === 'No open readers.' ? [] : JSON.parse(t); } };
}

test('a hook document (another process) is visible to the server: list, peek, close; owner = session_id', async () => {
  const srv = await server('sess-A');          // server started BEFORE the interception
  const h = runHook('sess-A');
  expect(h.id).toMatch(/^ctx_[0-9a-f]{8}$/);
  expect(h.pointer).toMatch(new RegExp(`^\\[READER ${h.id}\\] Bash output intercepted: 13893 bytes, 3001 lines`));
  expect(h.pointer).not.toContain('1500');
  expect(h.out.hookSpecificOutput.updatedToolOutput).toMatchObject({ stderr: '', interrupted: false, isImage: false, noOutputExpected: false });

  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${h.id}.meta.json`), 'utf8'));
  expect(meta.owner).toBe('sess-A');

  expect((await srv.list()).map((d) => d.id)).toEqual([h.id]);
  expect(await srv.call('reader_peek', { id: h.id, start_line: 2999, end_line: 2999 })).toBe('2999\t2999');
  expect(await srv.call('reader_close', { id: h.id })).toBe(`Closed ${h.id}.`);
  expect(fs.existsSync(path.join(dir, `${h.id}.txt`))).toBe(false);
  expect(await srv.list()).toEqual([]);
});

test('another owner cannot close the hook document and does not see it in list; can read it by id', async () => {
  const h = runHook('sess-A');
  const other = await server('sess-B');
  expect(await other.list()).toEqual([]);
  expect(await other.call('reader_close', { id: h.id })).toMatch(/belongs to another session/);
  expect(fs.existsSync(path.join(dir, `${h.id}.txt`))).toBe(true);
  expect(await other.call('reader_peek', { id: h.id, start: 1, end: 2 })).toBe('1\t1\n2\t2');
  const any = await server(undefined);        // no owner — everything is visible
  expect((await any.list()).map((d) => d.id)).toEqual([h.id]);
});

test('the open limit is shared: hook and server documents of the same owner evict each other', async () => {
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(runHook('sess-A').id);
  const srv = await server('sess-A');
  expect((await srv.list()).length).toBe(10);
  // the 11th from the hook (a new process) evicts the oldest — and says so in the pointer
  const h11 = runHook('sess-A');
  expect(h11.pointer).toContain(`evicted ${ids[0]}`);
  let open = (await srv.list()).map((d) => d.id);
  expect(open.length).toBe(10);
  expect(open).not.toContain(ids[0]);
  // the server accessing ids[1] makes it fresh: the next victim will be ids[2]
  await srv.call('reader_peek', { id: ids[1], start: 1, end: 1 });
  const opened = await srv.call('reader_open', { text: 'x\ny', briefing: 'test' });
  expect(opened).toContain(`evicted ${ids[2]}`);
  open = (await srv.list()).map((d) => d.id);
  expect(open.length).toBe(10);
  expect(open).toContain(ids[1]);
  // another owner does not consume sess-A's limit
  const hB = runHook('sess-B');
  expect(hB.pointer).not.toContain('evicted');
});

test('small output and a tool outside the allowlist pass through unchanged, the directory is untouched', () => {
  const small = runHook('sess-A', 'ok\n');
  expect(small.out).toEqual({});
  const notAllowed = runHook('sess-A', SEQ, { tool_name: 'Grep' });
  expect(notAllowed.out).toEqual({});
  expect(fs.readdirSync(dir)).toEqual([]);
});
