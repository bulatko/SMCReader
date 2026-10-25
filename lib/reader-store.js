/**
 * ReaderStore — document storage for the reader MCP (pull model of context).
 *
 * Keeps large texts OUTSIDE the main agent's context: the raw content is spilled
 * to disk ($READER_DIR/ctx_<8hex>.txt + .meta.json); the Map holds only
 * metadata + the id of the haiku dialog session. Document text is never kept
 * in process memory — peek() reads from disk.
 *
 * No LLM and no SDK — 100% unit-testable. The Haiku transport lives in reader-model.js.
 *
 * CROSS-PROCESS: the directory is shared by several processes (the hook command
 * writes, the MCP server reads). Disk is the source of truth: list, the MAX_OPEN
 * limit and eviction count documents by .meta.json files in the directory, not by
 * this process's Map; last-access time is the files' mtime (touch() sets it on every
 * get), so LRU and sweeping see accesses from any process. The Map holds only what
 * does not go to disk: the haiku dialog id, the question counter, the ask queue.
 *
 * Document owner: a single store may serve several sessions, and without ownership
 * a large output in one session would evict another session's documents, and
 * list/close would be shared. meta.owner (session id) is set at open: the MAX_OPEN
 * limit and eviction apply per owner, list({owner}) returns only that owner's
 * documents, close(id, {owner}) refuses to close someone else's. Reading by id
 * (get/peek/ask) is not restricted: only whoever was given the id knows it (e.g. a
 * handoff successor). No owner passed — legacy behavior (a store used by a single
 * agent has nothing to share).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OPEN_MAX = 5 * 1024 * 1024;   // >5MB — refused: grep the raw file directly
const ASK_MAX = 700 * 1024;         // >700KB — open works, but ask is unavailable (haiku window)
const MAX_OPEN = 10;                // max open readers
const MAX_ASKS = 20;                // max questions per reader
const SWEEP_AGE_MS = 48 * 60 * 60 * 1000; // on-disk TTL of raw files
const PREVIEW_HEAD = 20;
const PREVIEW_TAIL = 10;
const PREVIEW_CHAR_CAP = 1500;
const PEEK_MAX_LINES = 400;

/**
 * Source line number the document starts at: an intercepted Read(offset=219) holds file lines
 * 219…, and meta.lineBase = 219 keeps peek/ask/lines answers in FILE numbers. Default 1.
 */
function lineBaseOf(entry) {
  const b = entry && entry.meta && Number(entry.meta.lineBase);
  return Number.isInteger(b) && b > 1 ? b : 1;
}

function createReaderStore({ dir, now = Date.now, log = console.log } = {}) {
  if (!dir) throw new Error('createReaderStore requires {dir}');
  fs.mkdirSync(dir, { recursive: true });

  /** @type {Map<string, object>} id -> entry */
  const entries = new Map();

  // Access counter — the LRU order. A counter rather than now(): an open and an
  // access within the same millisecond would get the same stamp, and the victim
  // would be chosen arbitrarily. useSeq grows strictly monotonically, so "never
  // accessed" naturally degenerates into "by open time".
  let useSeq = 0;
  function touch(entry) {
    entry.useSeq = ++useSeq;
    entry.lastUsedAt = now();
    // Make the access visible to other processes and to sweeping: mtime of both files = access time.
    const t = entry.lastUsedAt / 1000;
    for (const p of [txtPath(entry.id), metaPath(entry.id)]) {
      try { fs.utimesSync(p, t, t); } catch (_) { /* file already gone — get will handle it */ }
    }
    return entry;
  }

  const ID_RE = /^ctx_[0-9a-f]{8}$/;
  const validId = (id) => typeof id === 'string' && ID_RE.test(id);
  const txtPath = (id) => path.join(dir, `${id}.txt`);
  const metaPath = (id) => path.join(dir, `${id}.meta.json`);

  /**
   * All open documents in the DIRECTORY (not only this process's). Own entries come from
   * the Map with their asks/useSeq; foreign ones (opened by another process) come from
   * disk: lastUsedAt = meta mtime, useSeq 0. Corrupt meta or missing raw file — no document.
   */
  function allOpen() {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return []; }
    const out = [];
    for (const name of names) {
      const m = /^(ctx_[0-9a-f]{8})\.meta\.json$/.exec(name);
      if (!m) continue;
      const id = m[1];
      const hit = entries.get(id);
      if (hit && !hit.closed) {
        if (fs.existsSync(txtPath(id))) out.push(hit); else entries.delete(id);
        continue;
      }
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
        if (!fs.existsSync(txtPath(id))) continue;
        out.push({ id, meta, asks: 0, useSeq: 0, lastUsedAt: fs.statSync(metaPath(id)).mtimeMs, closed: false });
      } catch (_) { /* corrupt meta / race with close */ }
    }
    return out;
  }

  /** a has been idle longer than b: earlier last access; within the same millisecond — by counter. */
  const lastUse = (e) => e.lastUsedAt || e.meta.createdAt || 0;
  const older = (a, b) => (lastUse(a) !== lastUse(b) ? lastUse(a) < lastUse(b) : a.useSeq <= b.useSeq);

  /** Delete ctx files older than SWEEP_AGE_MS (called on store creation and in open). */
  function sweep() {
    let removed = 0;
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { return 0; }
    for (const name of names) {
      if (!/^ctx_[0-9a-f]{8}\.(txt|meta\.json)$/.test(name)) continue;
      const p = path.join(dir, name);
      try {
        if (now() - fs.statSync(p).mtimeMs > SWEEP_AGE_MS) {
          fs.unlinkSync(p);
          removed++;
          entries.delete(name.replace(/\.(txt|meta\.json)$/, ''));
        }
      } catch (_) { /* race with close — harmless */ }
    }
    return removed;
  }

  function makePreview(text) {
    const lines = text.split('\n');
    const numbered = (arr, offset) => arr.map((l, i) => `${offset + i + 1}\t${l}`);
    let parts;
    if (lines.length <= PREVIEW_HEAD + PREVIEW_TAIL) {
      parts = numbered(lines, 0);
    } else {
      parts = [
        ...numbered(lines.slice(0, PREVIEW_HEAD), 0),
        `... (${lines.length - PREVIEW_HEAD - PREVIEW_TAIL} lines omitted) ...`,
        ...numbered(lines.slice(-PREVIEW_TAIL), lines.length - PREVIEW_TAIL),
      ];
    }
    let preview = parts.join('\n');
    if (preview.length > PREVIEW_CHAR_CAP) preview = preview.slice(0, PREVIEW_CHAR_CAP) + '…';
    return preview;
  }

  /**
   * Open a document. source: {path} XOR {text}; briefing is required.
   * @returns {{id, size, lines, preview, tooLargeForAsk}}
   */
  function open(source, briefing, extraMeta = {}) {
    const hasPath = typeof source?.path === 'string';
    const hasText = typeof source?.text === 'string';
    if (hasPath === hasText) throw new Error('provide exactly one of {path} or {text}');
    if (!briefing || typeof briefing !== 'string') throw new Error('briefing is required');

    sweep();
    // Overflow is NOT a refusal. Refusing here would cost more than evicting: the
    // interception hook swallows the exception fail-open, so the whole large output
    // would go into the context window — context hygiene would silently switch off
    // at the 11th document and never come back (the store outlives a turn). Evict
    // the least recently used one, and LOUDLY: the victim id goes both to the log and
    // to the returned field so the caller can show it to the agent. Silent eviction
    // would be the same problem.
    // while, not if: other processes (the hook command) also write documents into the
    // directory, and a single eviction could leave the store over the limit forever.
    // The normal path is exactly one iteration.
    let evicted = null;
    const owner = extraMeta.owner ?? null;
    let open_ = allOpen().filter((e) => (e.meta.owner ?? null) === owner);
    while (open_.length >= MAX_OPEN) {
      const victim = open_.reduce((a, b) => (older(a, b) ? a : b));
      const idleMs = Math.max(0, now() - (victim.lastUsedAt || victim.meta.createdAt));
      close(victim.id);                  // same path as a manual close: raw file off disk, entry out of the map
      evicted = victim.id;
      try {
        log(`[reader-store] evicted ${victim.id} (LRU, ${MAX_OPEN}/${MAX_OPEN} open${owner ? ` for ${owner}` : ''}, idle ${Math.round(idleMs / 1000)}s, asks ${victim.asks})`);
      } catch (_) { /* logging must not break open */ }
      open_ = open_.filter((e) => e !== victim);
    }

    let text;
    if (hasPath) {
      const st = fs.statSync(source.path); // ENOENT/EACCES propagate as is
      if (st.isDirectory()) throw new Error(`${source.path} is a directory`);
      if (st.size > OPEN_MAX) throw new Error(`file is ${st.size} bytes (limit ${OPEN_MAX}). Grep it directly or open an excerpt as {text}`);
      text = fs.readFileSync(source.path, 'utf8');
    } else {
      if (Buffer.byteLength(source.text, 'utf8') > OPEN_MAX) throw new Error(`text is too large (limit ${OPEN_MAX} bytes)`);
      text = source.text;
    }

    const id = 'ctx_' + crypto.randomBytes(4).toString('hex');
    const size = Buffer.byteLength(text, 'utf8');
    const meta = {
      id,
      size,
      lines: text.split('\n').length,
      createdAt: now(),
      briefing,
      source: hasPath ? { path: source.path } : { text: 'inline' },
      tooLargeForAsk: size > ASK_MAX,
      ...extraMeta, // e.g. tool_name, tool_input, owner
    };
    fs.writeFileSync(txtPath(id), text); // raw bytes as is; line numbering happens at ask/peek
    fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));

    const entry = { id, rawPath: txtPath(id), meta, haikuSid: null, asks: 0, lock: Promise.resolve(), closed: false };
    touch(entry);
    entries.set(id, entry);
    // evicted is an added field, not a replacement: existing callers take id/size/lines/
    // preview/tooLargeForAsk and notice nothing (null when nothing had to be evicted).
    return { id, size, lines: meta.lines, preview: makePreview(text), tooLargeForAsk: meta.tooLargeForAsk, evicted };
  }

  /**
   * Find an entry; on a miss — lazy reload from disk (a restart loses only the haiku dialog).
   * Any access counts as use: ask, peek and readRaw all go through get, so the LRU stamp
   * is set here, in one place.
   */
  function get(id) {
    if (!validId(id)) return null;
    const hit = entries.get(id);
    if (hit && !hit.closed) {
      if (fs.existsSync(txtPath(id))) return touch(hit);
      entries.delete(id); // closed by another process (or swept) — don't trust the in-memory entry
      return null;
    }
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
      if (!fs.existsSync(txtPath(id))) return null;
      const entry = {
        id, rawPath: txtPath(id), meta,
        haikuSid: null, asks: 0, lock: Promise.resolve(), closed: false,
        rehydrated: true, // the first ask will report that the dialog was reset by a restart
      };
      touch(entry);
      entries.set(id, entry);
      return entry;
    } catch (_) {
      return null; // meta missing or corrupt — treat as nonexistent
    }
  }

  /**
   * Verbatim numbered slice from DISK. Inclusive; clamped to bounds.
   * Numbers are SOURCE numbers: for an excerpt Read(offset=219) the first document line is file
   * line 219 (meta.lineBase), and peek(id, 219, 219) returns it. Without lineBase — from 1.
   */
  function peek(id, startLine, endLine) {
    const entry = get(id);
    if (!entry) throw new Error(`no reader '${id}'`);
    const lines = fs.readFileSync(entry.rawPath, 'utf8').split('\n');
    const base = lineBaseOf(entry);
    const last = base + lines.length - 1;
    const start = Math.max(base, Math.min(startLine, last));
    const end = Math.max(base, Math.min(endLine, last));
    if (start > end) throw new Error(`start_line ${startLine} > end_line ${endLine}`);
    if (end - start + 1 > PEEK_MAX_LINES) {
      throw new Error(`span is ${end - start + 1} lines (max ${PEEK_MAX_LINES}). Narrow the range`);
    }
    return lines.slice(start - base, end - base + 1).map((l, i) => `${start + i}\t${l}`).join('\n');
  }

  /** Read the whole raw file (for the haiku reader on the first ask). */
  function readRaw(id) {
    const entry = get(id);
    if (!entry) throw new Error(`no reader '${id}'`);
    return fs.readFileSync(entry.rawPath, 'utf8');
  }

  function ownerOf(id) {
    if (!validId(id)) return null;
    const e = entries.get(id);
    if (e) return e.meta.owner ?? null;
    try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')).owner ?? null; } catch (_) { return null; }
  }

  /**
   * Close and delete the files. Idempotent. {owner} — another owner's document is not closed (throws).
   * Documents of the session's subagents (owner `<owner>/agent:<id>`, intercept-hook.js) count as
   * the session's own: a session and its subagents share one reader MCP server, with the session owner.
   * The owner is read from disk — the document may have been opened by another process.
   */
  function close(id, { owner } = {}) {
    // id goes into the unlink path: '../x' would delete an unrelated *.txt file outside the directory
    if (!validId(id)) return false;
    if (owner !== undefined) {
      const o = ownerOf(id);
      if (o && o !== owner && !(owner && o.startsWith(`${owner}/`))) {
        throw new Error(`reader '${id}' belongs to another session — it is not yours to close`);
      }
    }
    const entry = entries.get(id);
    if (entry) { entry.closed = true; entries.delete(id); }
    let existed = false;
    for (const p of [txtPath(id), metaPath(id)]) {
      try { fs.unlinkSync(p); existed = true; } catch (_) { /* already gone */ }
    }
    return existed || !!entry;
  }

  /** {owner} — only this owner's documents; no argument — all of them. */
  function list({ owner } = {}) {
    return allOpen()
      .filter((e) => owner === undefined || (e.meta.owner ?? null) === owner)
      .sort((a, b) => (a.meta.createdAt - b.meta.createdAt) || (a.useSeq - b.useSeq))
      .map((e) => ({
        id: e.id, size: e.meta.size, lines: e.meta.lines,
        briefing: e.meta.briefing, asks: e.asks,
        opened: new Date(e.meta.createdAt).toISOString(),
        tooLargeForAsk: !!e.meta.tooLargeForAsk,
      }));
  }

  /** Gate for ask — a pure function, tested directly. */
  function canAsk(entry) {
    if (entry.meta.tooLargeForAsk) {
      return { ok: false, reason: `document is ${entry.meta.size} bytes (ask limit ${ASK_MAX}). Use reader_peek for verbatim ranges, Grep the source, or open a smaller excerpt with {text}` };
    }
    // In-flight questions count: asks grows only when a question completes, so a batch of
    // parallel questions used to pass this check all at once (asks=19 + 8 parallel → 27 of 20).
    if (entry.asks + (entry.inFlight || 0) >= MAX_ASKS) {
      return { ok: false, reason: `ask limit reached (${MAX_ASKS}) for this reader. Close it and reopen with a fresh briefing` };
    }
    return { ok: true };
  }

  sweep(); // sweep on creation (server restart)
  return { open, get, peek, readRaw, close, list, canAsk, sweep, limits: { OPEN_MAX, ASK_MAX, MAX_OPEN, MAX_ASKS, PEEK_MAX_LINES } };
}

module.exports = { createReaderStore, lineBaseOf };
