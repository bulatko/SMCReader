#!/usr/bin/env node
/**
 * Parses the stream-json of a `claude -p --output-format stream-json --verbose` run:
 * the verdict is based on what the model RECEIVED (tool_result), not on what it said.
 *
 *   node e2e/check-stream.js <stream.jsonl> <tool> <must-not-contain> <want> [store-dir] [tool-prefix]
 *
 * tool-prefix — prefix of the reader tools (default mcp__reader__; a plugin yields
 * mcp__plugin_<plugin>_<server>__). Pass "-" for an empty store-dir.
 *
 * Check 1: the tool_result of the first <tool> call contains "[READER ctx_" and does NOT contain <must-not-contain>.
 * Check 2: there was a <tool-prefix>* call with that id, and its tool_result contains <want>.
 * Prints one JSON line: {check1:{ok,reason,id}, check2:{ok,reason}, calls:[...]}; always exits 0.
 */

'use strict';

const fs = require('fs');

const [file, toolName, forbidden, want] = process.argv.slice(2);
const prefix = process.argv[7] || 'mcp__reader__';
const uses = [];          // {id, name, input}
const results = new Map(); // tool_use_id -> text
let resultMsg = null;
let sessionId = null;

const textOf = (c) => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return c == null ? '' : JSON.stringify(c);
};

let raw = '';
try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { raw = ''; }
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  let m;
  try { m = JSON.parse(line); } catch (_) { continue; }
  if (m.type === 'result') resultMsg = m;
  if (!sessionId && typeof m.session_id === 'string') sessionId = m.session_id;
  const content = m.message && Array.isArray(m.message.content) ? m.message.content : [];
  for (const b of content) {
    if (m.type === 'assistant' && b.type === 'tool_use') uses.push({ id: b.id, name: b.name, input: b.input || {} });
    if (m.type === 'user' && b.type === 'tool_result') results.set(b.tool_use_id, textOf(b.content));
  }
}

const out = {
  calls: uses.map((u) => u.name),
  cost_usd: resultMsg ? resultMsg.total_cost_usd : null,
  duration_ms: resultMsg ? resultMsg.duration_ms : null,
};

const target = uses.find((u) => u.name === toolName);
let docId = null;
if (!target) {
  out.check1 = { ok: false, reason: `no ${toolName} call in the stream (${uses.length} tool calls total)` };
} else {
  const r = results.get(target.id);
  if (r === undefined) out.check1 = { ok: false, reason: `${toolName} call ${target.id} has no tool_result` };
  else {
    const m = /\[READER (ctx_[0-9a-f]{8})\]/.exec(r);
    docId = m ? m[1] : null;
    if (!m) out.check1 = { ok: false, reason: `${toolName} tool_result has no "[READER ctx_" pointer (${r.length} chars reached the model, first: ${JSON.stringify(r.slice(0, 60))})` };
    else if (r.includes(forbidden)) out.check1 = { ok: false, reason: `${toolName} tool_result contains "${forbidden}" — the original output reached the model` };
    else out.check1 = { ok: true, id: docId, chars: r.length };
  }
}

if (!docId) {
  out.check2 = { ok: false, reason: 'no reader id from check 1' };
} else {
  const readerCalls = uses.filter((u) => u.name.startsWith(prefix) && JSON.stringify(u.input).includes(docId));
  if (!readerCalls.length) out.check2 = { ok: false, reason: `no ${prefix}* call with id ${docId} (calls: ${out.calls.join(',')})` };
  else {
    const hit = readerCalls.find((u) => (results.get(u.id) || '').includes(want));
    out.check2 = hit
      ? { ok: true, tool: hit.name, input: hit.input }
      : { ok: false, reason: `${prefix}* calls with ${docId} returned no "${want}": ${readerCalls.map((u) => `${u.name} -> ${JSON.stringify((results.get(u.id) || '').slice(0, 80))}`).join('; ')}` };
  }
}

// Informational (not part of the verdict): document owner in meta vs. the stream's session_id.
const storeDir = process.argv[6];
if (storeDir && storeDir !== '-' && docId) {
  try { out.owner = JSON.parse(fs.readFileSync(require('path').join(storeDir, `${docId}.meta.json`), 'utf8')).owner; } catch (_) { out.owner = null; }
  out.session_id = sessionId;
}

process.stdout.write(JSON.stringify(out) + '\n');
