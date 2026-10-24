/**
 * Unit tests: lib/intercept-hook.js (PostToolUse intercept).
 */

const { createInterceptHook, extractText, headTail } = require('../lib/intercept-hook');

function fakeStore() {
  const opened = [];
  return {
    opened,
    open(source, briefing, extra) {
      opened.push({ source, briefing, extra });
      return { id: 'ctx_fake0001', size: Buffer.byteLength(source.text), lines: source.text.split('\n').length };
    },
  };
}

const noLog = () => {};
const BIG = 'x'.repeat(3000) + '\nlast line';

describe('extractText — tool_response shapes', () => {
  test('string passes through', () => {
    expect(extractText('hello')).toEqual({ text: 'hello', shape: 'string' });
  });
  test('{stdout, stderr} merges with marker, shape=stdout', () => {
    const r = extractText({ stdout: 'out', stderr: 'err' });
    expect(r.shape).toBe('stdout');
    expect(r.text).toContain('out');
    expect(r.text).toContain('--- stderr ---');
    expect(r.text).toContain('err');
  });
  test('MCP content blocks join their text, shape=content', () => {
    const r = extractText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] });
    expect(r).toEqual({ text: 'a\nb', shape: 'content' });
  });
  test('unknown object shape → empty text + shape unknown (not intercepted)', () => {
    expect(extractText({ weird: 1 })).toEqual({ text: '', shape: 'unknown' });
  });
  test('null/undefined → empty unknown', () => {
    expect(extractText(null)).toEqual({ text: '', shape: 'unknown' });
    expect(extractText(undefined)).toEqual({ text: '', shape: 'unknown' });
  });
});

describe('createInterceptHook — gating', () => {
  test('non-allowlisted tool passes through untouched', async () => {
    const store = fakeStore();
    const hook = createInterceptHook({ store, log: noLog });
    const out = await hook({ tool_name: 'Read', tool_response: BIG, tool_input: {} });
    expect(out).toEqual({});
    expect(store.opened).toHaveLength(0);
  });

  test('small output passes through untouched', async () => {
    const store = fakeStore();
    const hook = createInterceptHook({ store, log: noLog });
    const out = await hook({ tool_name: 'Bash', tool_response: 'short', tool_input: { command: 'ls' } });
    expect(out).toEqual({});
    expect(store.opened).toHaveLength(0);
  });

  test('reader tools themselves are never intercepted (no recursion)', async () => {
    const store = fakeStore();
    const hook = createInterceptHook({ store, log: noLog });
    const out = await hook({ tool_name: 'mcp__reader__reader_ask', tool_response: BIG, tool_input: {} });
    expect(out).toEqual({});
  });
});

describe('createInterceptHook — interception', () => {
  test('big Bash output → store.open + replacement MIRRORS the stdout shape', async () => {
    const store = fakeStore();
    const hook = createInterceptHook({ store, log: noLog });
    const out = await hook({
      tool_name: 'Bash',
      tool_response: { stdout: BIG, stderr: 'noise', interrupted: false, isImage: false },
      tool_input: { command: 'npm install --verbose' },
    });
    expect(store.opened).toHaveLength(1);
    expect(store.opened[0].briefing).toContain('npm install --verbose');
    expect(store.opened[0].extra).toMatchObject({ tool_name: 'Bash' });

    // the replacement is an object of the same shape (not a bare string!), otherwise the engine rejects it
    const repl = out.hookSpecificOutput.updatedToolOutput;
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(typeof repl).toBe('object');
    expect(repl.interrupted).toBe(false); // other fields preserved
    expect(repl.stderr).toBe('');         // stderr cleared (the note is in the pointer)
    expect(repl.stdout).toContain('[READER ctx_fake0001]');
    expect(repl.stdout).toContain('reader_ask');
    expect(repl.stdout).toContain('last line'); // tail is visible
    expect(repl.stdout.length).toBeLessThan(1600);
  });

  test('string-shaped output → string replacement; MCP content → content replacement', async () => {
    const store = fakeStore();
    // an MCP tool is intercepted only via an explicit allowlist (default: Bash/WebFetch)
    const hook = createInterceptHook({ store, threshold: 10, log: noLog, allowlist: ['WebFetch', 'mcp__remote__execute_command'] });
    const big = 'y'.repeat(50);

    const sOut = await hook({ tool_name: 'WebFetch', tool_response: big, tool_input: { url: 'http://x' } });
    expect(typeof sOut.hookSpecificOutput.updatedToolOutput).toBe('string');

    const cOut = await hook({
      tool_name: 'mcp__remote__execute_command',
      tool_response: { content: [{ type: 'text', text: big }] },
      tool_input: {},
    });
    const repl = cOut.hookSpecificOutput.updatedToolOutput;
    expect(Array.isArray(repl.content)).toBe(true);
    expect(repl.content[0].text).toContain('[READER');
  });

  test('unknown output shape → passes through, no reader created', async () => {
    const store = fakeStore();
    const hook = createInterceptHook({ store, threshold: 10, log: noLog });
    const out = await hook({ tool_name: 'Bash', tool_response: { weird: 'x'.repeat(100) }, tool_input: {} });
    expect(out).toEqual({});
    expect(store.opened).toHaveLength(0);
  });

  test('store failure → fail-open (output passes through)', async () => {
    const store = { open() { throw new Error('disk full'); } };
    const hook = createInterceptHook({ store, log: noLog });
    const out = await hook({ tool_name: 'Bash', tool_response: BIG, tool_input: {} });
    expect(out).toEqual({});
  });
});

// The pointer is the only thing the agent actually reads. If the store evicted another
// document to make room for this interception, the agent must learn it FROM THERE, not
// from the server log it cannot see.
describe('createInterceptHook — eviction signal', () => {
  const evictingStore = (evicted) => ({
    limits: { MAX_OPEN: 10 },
    open: () => ({ id: 'ctx_deadbeef', size: 3010, lines: 2, evicted }),
  });

  test('eviction is appended to the pointer: evicted id, counter and how to fix', async () => {
    const hook = createInterceptHook({ store: evictingStore('ctx_0ldd0c00'), log: noLog });
    const out = await hook({ tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: BIG } });
    const pointer = out.hookSpecificOutput.updatedToolOutput.stdout;
    expect(pointer).toContain('evicted ctx_0ldd0c00');
    expect(pointer).toContain('10/10');
    expect(pointer).toContain('reader_close');
  });

  test('without eviction the pointer is unchanged — no extra line appears', async () => {
    const hook = createInterceptHook({ store: evictingStore(null), log: noLog });
    const out = await hook({ tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: BIG } });
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).not.toContain('evicted');
  });

  test('a store without limits (older caller) does not break interception', async () => {
    const store = { open: () => ({ id: 'ctx_deadbeef', size: 3010, lines: 2, evicted: 'ctx_0ldd0c00' }) };
    const hook = createInterceptHook({ store, log: noLog });
    const out = await hook({ tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: BIG } });
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).toContain('evicted ctx_0ldd0c00');
  });
});

describe('headTail', () => {
  test('short text returned as-is; long text keeps head and tail with omission marker', () => {
    expect(headTail('a\nb')).toBe('a\nb');
    const lines = Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join('\n');
    const ht = headTail(lines);
    expect(ht).toContain('L1');
    expect(ht).toContain('L50');
    expect(ht).toContain('omitted');
    expect(ht).not.toContain('L25');
  });
});
