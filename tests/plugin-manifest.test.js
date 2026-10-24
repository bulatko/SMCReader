/**
 * Unit: the plugin manifests match the npm package. The plugin's MCP server is started with
 * `npx --package=smcreader@<version>`, so .mcp.json must pin the version being released.
 */

'use strict';

const pkg = require('../package.json');
const plugin = require('../.claude-plugin/plugin.json');
const mcp = require('../.mcp.json');

test('plugin.json version equals package.json version', () => {
  expect(plugin.name).toBe(pkg.name);
  expect(plugin.version).toBe(pkg.version);
});

test('.mcp.json starts this exact version via npx without optional native binaries', () => {
  const server = mcp.smcreader;
  expect(server.command).toBe('npx');
  expect(server.args).toEqual(['-y', '--omit=optional', `--package=${pkg.name}@${pkg.version}`, 'smcreader-mcp']);
  expect(pkg.bin['smcreader-mcp']).toBeDefined();
});
