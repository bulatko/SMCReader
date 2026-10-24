/**
 * Unit tests: the interception briefing carries the agent's task; the agent's reader is loaded up front.
 *
 * Without the task, every interception briefing was a generic "look for errors" template and the
 * reader had no goal to read against; loading the reader tools on demand cost an extra ToolSearch
 * each time. Large outputs still go to the reader.
 */
'use strict';

const { createInterceptHook } = require('../lib/intercept-hook');

// The SDK doesn't load under jest (ESM) — as in context-factories.test.js, capture the createSdkMcpServer options.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: jest.fn((o) => ({ type: 'sdk', name: o.name, alwaysLoad: o.alwaysLoad, instance: { tools: o.tools } })),
  tool: jest.fn((name, description, schema, handler) => ({ name, description, schema, handler })),
}));

function fakeStore() {
  const opened = [];
  return {
    opened,
    open(source, briefing, extra) {
      opened.push({ source, briefing, extra });
      return { id: 'ctx_task0001', size: source.text.length, lines: source.text.split('\n').length };
    },
  };
}
const noLog = () => {};
const lines = (n) => Array.from({ length: n }, (_, i) => `${i + 1} ${'x'.repeat(60)}`).join('\n');
const bash = (command, stdout, description) => ({ tool_name: 'Bash', tool_input: { command, ...(description && { description }) }, tool_response: { stdout, stderr: '', interrupted: false } });

describe('interception briefing', () => {
  const hook = (store, extra = {}) => createInterceptHook({ store, threshold: 4096, allowlist: ['Bash'], log: noLog, ...extra });

  test("carries the agent's task and its call description", async () => {
    const store = fakeStore();
    const out = await hook(store, { taskContext: () => 'skill-forge: the pipeline builds a skill' })(
      bash('npx jest 2>&1', lines(200), 'finding which skill-forge tests fail and why'));
    expect(store.opened[0].briefing).toContain("The agent's task: skill-forge: the pipeline builds a skill");
    expect(store.opened[0].briefing).toContain('Its own description of this call: finding which skill-forge tests fail and why');
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).toContain('[READER ctx_task0001]');
  });

  test('a broken taskContext does not break interception — briefing without a task', async () => {
    const store = fakeStore();
    await hook(store, { taskContext: () => { throw new Error('boom'); } })(bash('npx jest 2>&1', lines(200)));
    expect(store.opened).toHaveLength(1);
    expect(store.opened[0].briefing).not.toContain("The agent's task");
  });

  test('without taskContext (main agent) — the default template', async () => {
    const store = fakeStore();
    await hook(store)(bash('npx jest 2>&1', lines(200)));
    expect(store.opened[0].briefing).toBe('Intercepted output of Bash (npx jest 2>&1). The main agent saw only a head/tail pointer and will ask about specifics. Watch for: errors, warnings, anomalies, unexpected values.');
  });
});

describe('reader without deferred loading', () => {
  test('the reader asks the SDK for alwaysLoad only when requested', () => {
    const { createReaderMcpServer } = require('../lib/reader-mcp');
    const store = { open() {}, get() {}, list() { return []; } };
    expect(createReaderMcpServer({ store, alwaysLoad: true }).alwaysLoad).toBe(true);
    expect(createReaderMcpServer({ store }).alwaysLoad).toBeUndefined();
  });
});

// When the reader is the agent's main way of reading, the pointer should teach it to ask
// questions rather than pull the whole output back via peek.
describe('pointer line: askHint', () => {
  test('askHint set — the last pointer line comes from it, the default one is absent', async () => {
    const store = fakeStore();
    const out = await createInterceptHook({ store, threshold: 4096, allowlist: ['Bash'], log: noLog,
      askHint: (id) => `Ask what you need: mcp__reader__reader_ask(${id}, question)` })(bash('npx jest 2>&1', lines(200)));
    const ptr = out.hookSpecificOutput.updatedToolOutput.stdout;
    expect(ptr.split('\n').pop()).toBe('Ask what you need: mcp__reader__reader_ask(ctx_task0001, question)');
    expect(ptr).not.toContain('Full output is in reader');
  });

  test('without askHint (main agent) — the default pointer line', async () => {
    const store = fakeStore();
    const out = await createInterceptHook({ store, threshold: 4096, allowlist: ['Bash'], log: noLog })(bash('npx jest 2>&1', lines(200)));
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).toContain('Full output is in reader ctx_task0001: mcp__reader__reader_ask(id, question) to analyze');
  });

});
