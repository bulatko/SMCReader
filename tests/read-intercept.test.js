/**
 * Unit: INTERCEPTING LARGE Read OUTPUTS.
 *
 * Why a separate file rather than a case in intercept-hook.test.js: this checks
 * not the hook in general but a SPECIFIC failure. Bash outputs were intercepted,
 * while Read outputs were not intercepted at all, so large file contents went
 * into the context in full.
 * The cause was not the tool list but the response SHAPE: Read returns
 * {type:'text', file:{filePath, content, …}}, which extractText didn't know, and
 * the hook silently failed open (shape:'unknown' → interception skipped). A silent
 * mechanism is indistinguishable from a working one until you measure it — this
 * test is that measurement.
 *
 * Read has its OWN threshold (8 KB vs the general 4 KB): Read is also "fetch a file
 * to edit it", and Edit needs exact bytes, so typical working reads (a few KB) must
 * pass through. At 4 KB, actual working reads would start being intercepted.
 */

'use strict';

const { createInterceptHook, extractText } = require('../lib/intercept-hook');

function fakeStore() {
  const opened = [];
  return {
    opened,
    open(source, briefing, extra) {
      opened.push({ source, briefing, extra });
      return { id: 'ctx_read0001', size: Buffer.byteLength(source.text), lines: source.text.split('\n').length };
    },
  };
}

const noLog = () => {};

/** A Read response in exactly the shape the SDK delivers. */
function readResponse(content, filePath = '/tmp/big.md') {
  return {
    type: 'text',
    file: { filePath, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length },
  };
}

const HUGE = ('a line of a big file\n').repeat(2000);    // ~41 KB
const WORK = ('a line of a work file\n').repeat(150);    // ~3.3 KB — a typical Read before an edit

describe('Read response shape', () => {
  test('extractText gets the text from {file:{content}} and names the shape file', () => {
    const r = extractText(readResponse('hello'));
    expect(r).toEqual({ text: 'hello', shape: 'file' });
  });

  test('without a content field the shape stays unknown — interception does not guess', () => {
    expect(extractText({ type: 'text', file: { filePath: '/x' } })).toEqual({ text: '', shape: 'unknown' });
  });
});

describe('intercepting a large Read', () => {
  test('output above the threshold goes to the reader, and a pointer goes into the context', async () => {
    const store = fakeStore();
    const hook = createInterceptHook({ store, threshold: 8 * 1024, allowlist: ['Read'], log: noLog });
    const out = await hook({ tool_name: 'Read', tool_response: readResponse(HUGE), tool_input: { file_path: '/tmp/big.md' } });

    expect(store.opened).toHaveLength(1);                 // text is stored in full
    expect(store.opened[0].source.text).toBe(HUGE);
    const replaced = out?.hookSpecificOutput?.updatedToolOutput;
    expect(replaced).toBeTruthy();
    // SHAPE IS MIRRORED: the engine applies the replacement only if the structure matches.
    expect(replaced.type).toBe('text');
    expect(replaced.file.filePath).toBe('/tmp/big.md');
    expect(typeof replaced.file.content).toBe('string');
    expect(replaced.file.content).toContain('ctx_read0001');
    // The savings are the whole point: the pointer is orders of magnitude shorter than the body.
    expect(replaced.file.content.length).toBeLessThan(HUGE.length / 10);
  });

  test('a working Read (below the threshold) passes through — file editing is not broken', async () => {
    const store = fakeStore();
    const hook = createInterceptHook({ store, threshold: 8 * 1024, allowlist: ['Read'], log: noLog });
    const out = await hook({ tool_name: 'Read', tool_response: readResponse(WORK), tool_input: { file_path: '/tmp/small.md' } });

    expect(out).toEqual({});                              // no replacement, no reader
    expect(store.opened).toHaveLength(0);
  });

  test('the default interceptor leaves Read alone — Read is intercepted only via an explicit allowlist', async () => {
    const store = fakeStore();
    const { DEFAULT_ALLOWLIST } = require('../lib/intercept-hook');
    expect(DEFAULT_ALLOWLIST).not.toContain('Read');
    const general = createInterceptHook({ store, threshold: 4 * 1024, allowlist: DEFAULT_ALLOWLIST, log: noLog });
    const out = await general({ tool_name: 'Read', tool_response: readResponse(HUGE), tool_input: {} });
    expect(out).toEqual({});
    expect(store.opened).toHaveLength(0);
  });
});
