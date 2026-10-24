/**
 * stdio-mcp — adapter of the core (lib/reader-tools.js) to stdio MCP (@modelcontextprotocol/sdk).
 * Claude Code launches it as a separate process (bin/smcreader-mcp); the store is the same
 * on-disk directory the hook command writes to (bin/smcreader-hook), so documents
 * intercepted by the hook are visible here by id, in list, and count toward the limit.
 */

'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { createReaderTools } = require('./reader-tools');

const VERSION = require('../package.json').version;

/** Build an McpServer with the reader tools (without connecting a transport). */
function buildMcpServer(toolOpts) {
  const server = new McpServer({ name: 'reader', version: VERSION });
  for (const t of createReaderTools(toolOpts)) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, (args) => t.handler(args || {}));
  }
  return server;
}

async function runStdio(toolOpts) {
  const server = buildMcpServer(toolOpts);
  await server.connect(new StdioServerTransport());
  return server;
}

module.exports = { buildMcpServer, runStdio };
