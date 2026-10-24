/**
 * reader-mcp — factory for the in-process "reader" MCP server for the Agent SDK
 * (createSdkMcpServer → options.mcpServers). Same tools as the stdio server,
 * from the same core (lib/reader-tools.js).
 *
 * In-process: the SDK keeps the instance in a per-query map and connects it on every query(),
 * so do NOT reuse one object across calls — call the factory on every turn.
 * The SDK is required LAZILY: it is ESM, and a static require breaks jest's parsing of
 * modules that import this one.
 */

'use strict';

const { createReaderTools, READER_TOOL_NAMES } = require('./reader-tools');

/**
 * @param {object} opts — same as createReaderTools, plus
 * @param {boolean} [opts.alwaysLoad] tools are in the prompt right away, without ToolSearch
 * @returns {object} McpSdkServerConfigWithInstance
 */
function createReaderMcpServer({ alwaysLoad = false, ...opts } = {}) {
  if (!opts.store) throw new Error('createReaderMcpServer requires {store}');
  const { createSdkMcpServer, tool } = require('@anthropic-ai/claude-agent-sdk');
  return createSdkMcpServer({
    name: 'reader',
    version: '1.0.0',
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
    tools: createReaderTools(opts).map((t) => tool(t.name, t.description, t.schema, t.handler)),
  });
}

module.exports = { createReaderMcpServer, READER_TOOL_NAMES };
