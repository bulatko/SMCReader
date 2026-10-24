#!/usr/bin/env node
/**
 * Fixture for e2e/mcp-gate.sh: stdio MCP server "fixture" with a big_output tool that
 * returns `seq 1 3000` as MCP content. If FIXTURE_ENV_DUMP is set, writes there the
 * environment variables Claude Code launched the MCP server with.
 */

'use strict';

const fs = require('fs');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

if (process.env.FIXTURE_ENV_DUMP) {
  try {
    const keys = Object.keys(process.env).filter((k) => /CLAUDE|SESSION|MCP/i.test(k)).sort();
    fs.writeFileSync(process.env.FIXTURE_ENV_DUMP, keys.map((k) => `${k}=${k.includes('TOKEN') || k.includes('KEY') ? '***' : process.env[k]}`).join('\n') + '\n');
  } catch (_) { /* */ }
}

const server = new McpServer({ name: 'fixture', version: '0.0.0' });
server.registerTool('big_output', { description: 'Returns numbers 1..3000, one per line.', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: Array.from({ length: 3000 }, (_, i) => String(i + 1)).join('\n') }],
}));
server.connect(new StdioServerTransport());
