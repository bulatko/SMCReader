/**
 * Unit: end-to-end verdict (e2e/check-stream.js) on synthetic stream-json —
 * the logic of checks 1 and 2 without running Claude Code.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CHECK = path.join(__dirname, '..', 'e2e', 'check-stream.js');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-e2echk-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, content) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const verdict = (msgs, extra = []) => {
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, msgs.map((m) => JSON.stringify(m)).join('\n') + '\nnot json\n');
  return JSON.parse(spawnSync(process.execPath, [CHECK, f, 'Bash', '1500', '2999', ...extra], { encoding: 'utf8' }).stdout);
};
const PTR = '[READER ctx_0123abcd] Bash output intercepted: 13893 bytes, 3001 lines (>2048 chars).\n1\n2\n...\n2999\n3000';

test('interception + peek with the same id → both checks pass', () => {
  const v = verdict([use('t1', 'Bash', { command: 'seq 1 3000' }), res('t1', PTR),
    use('t2', 'mcp__reader__reader_peek', { id: 'ctx_0123abcd', start_line: 2999, end_line: 2999 }), res('t2', [{ type: 'text', text: '2999\t2999' }])]);
  expect(v.check1).toMatchObject({ ok: true, id: 'ctx_0123abcd' });
  expect(v.check2).toMatchObject({ ok: true, tool: 'mcp__reader__reader_peek' });
});

test('no hook: full output reached the model → check 1 fails', () => {
  const full = Array.from({ length: 3000 }, (_, i) => i + 1).join('\n');
  const v = verdict([use('t1', 'Bash', {}), res('t1', full)]);
  expect(v.check1.ok).toBe(false);
  expect(v.check1.reason).toMatch(/no "\[READER ctx_" pointer/);
});

test('pointer present but the original leaked too → check 1 fails', () => {
  const v = verdict([use('t1', 'Bash', {}), res('t1', `${PTR}\n1500`)]);
  expect(v.check1.reason).toMatch(/contains "1500"/);
});

test('model answered without calling the reader / called it with another id → check 2 fails', () => {
  expect(verdict([use('t1', 'Bash', {}), res('t1', PTR)]).check2.ok).toBe(false);
  const other = verdict([use('t1', 'Bash', {}), res('t1', PTR),
    use('t2', 'mcp__reader__reader_peek', { id: 'ctx_ffffffff', start: 2999, end: 2999 }), res('t2', '2999\t2999')]);
  expect(other.check2.ok).toBe(false);
});

test('tool prefix as a parameter: plugin mcp__plugin_<p>_<s>__* calls count, mcp__reader__* do not', () => {
  const P = 'mcp__plugin_smcreader_smcreader__';
  const msgs = (name) => [use('t1', 'Bash', { command: 'seq 1 3000' }), res('t1', PTR),
    use('t2', name, { id: 'ctx_0123abcd', start_line: 2999, end_line: 2999 }), res('t2', '2999\t2999')];
  expect(verdict(msgs(`${P}reader_peek`), ['-', P]).check2).toMatchObject({ ok: true, tool: `${P}reader_peek` });
  const wrong = verdict(msgs('mcp__reader__reader_peek'), ['-', P]).check2;
  expect(wrong.ok).toBe(false);
  expect(wrong.reason).toContain(`no ${P}* call`);
  // default prefix is mcp__reader__
  expect(verdict(msgs(`${P}reader_peek`)).check2.ok).toBe(false);
});
