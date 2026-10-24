/**
 * Adapters over one core: stdio MCP (@modelcontextprotocol/sdk) and the in-process Agent SDK
 * factory (createSdkMcpServer) expose THE SAME tools (names, descriptions, fields).
 * The in-process server is built with the real SDK in a separate node process (the SDK is ESM
 * and does not load under jest).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createReaderStore } = require('../lib/reader-store');
const { createReaderTools, READER_TOOL_NAMES } = require('../lib/reader-tools');
const { buildMcpServer } = require('../lib/stdio-mcp');

jest.setTimeout(30000);

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-adapt-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const core = (store, askFormat) => createReaderTools({ store, askFormat })
  .map((t) => ({ name: t.name, description: t.description, fields: Object.keys(t.schema).sort() }));

test('stdio MCP: same tools as the core; zod schemas accepted (numeric strings coerced)', async () => {
  const store = createReaderStore({ dir, log: () => {} });
  const srv = buildMcpServer({ store, askFormat: 'lines' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await srv.connect(a);
  const c = new Client({ name: 't', version: '0' });
  await c.connect(b);
  const { tools } = await c.listTools();
  expect(tools.map((t) => ({ name: t.name, description: t.description, fields: Object.keys(t.inputSchema.properties || {}).sort() })))
    .toEqual(core(store, 'lines'));
  expect(tools.map((t) => `mcp__reader__${t.name}`)).toEqual(READER_TOOL_NAMES);
  const opened = (await c.callTool({ name: 'reader_open', arguments: { text: 'a\nb\nc', briefing: 'x' } })).content[0].text;
  const id = /ctx_[0-9a-f]{8}/.exec(opened)[0];
  expect((await c.callTool({ name: 'reader_peek', arguments: { id, start: '2', end_line: 3 } })).content[0].text).toBe('2\tb\n3\tc');
  await c.close();
});

test('in-process factory (real Agent SDK) builds and exposes the same tools', () => {
  const script = `
    const { createReaderMcpServer } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'reader-mcp'))});
    const { createReaderStore } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'reader-store'))});
    const cfg = createReaderMcpServer({ store: createReaderStore({ dir: ${JSON.stringify(dir)}, log: () => {} }), askFormat: 'lines' });
    const handlers = cfg.instance._registeredTools || {};
    process.stdout.write(JSON.stringify({ type: cfg.type, name: cfg.name,
      tools: Object.entries(handlers).map(([name, t]) => ({ name, description: t.description,
        fields: Object.keys((t.inputSchema && (t.inputSchema.shape || t.inputSchema.def?.shape)) || {}).sort() })) }));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  expect(r.stderr).toBe('');
  const got = JSON.parse(r.stdout);
  expect(got.type).toBe('sdk');
  expect(got.name).toBe('reader');
  expect(got.tools).toEqual(core(createReaderStore({ dir, log: () => {} }), 'lines'));
});
