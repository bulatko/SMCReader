'use strict';
// Public package entry point: core (store, reader model, tools) and adapters.
const { createReaderStore } = require('./reader-store');
const readerModel = require('./reader-model');
const { createReaderTools, READER_TOOL_NAMES } = require('./reader-tools');
const { createInterceptHook, extractText, buildReplacement, headTail, DEFAULT_ALLOWLIST, DEFAULT_THRESHOLD } = require('./intercept-hook');
const { createReadGuardHook } = require('./read-guard');
const { loadConfig } = require('./config');

module.exports = {
  createReaderStore, readerModel, createReaderTools, READER_TOOL_NAMES,
  createInterceptHook, extractText, buildReplacement, headTail, DEFAULT_ALLOWLIST, DEFAULT_THRESHOLD,
  createReadGuardHook, loadConfig,
  // adapters are loaded lazily: each pulls in its own SDK
  createReaderMcpServer: (...a) => require('./reader-mcp').createReaderMcpServer(...a),
  buildMcpServer: (...a) => require('./stdio-mcp').buildMcpServer(...a),
};
