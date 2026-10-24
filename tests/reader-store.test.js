/**
 * Unit tests: lib/reader-store.js + lib/reader-model.js (fake transport).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReaderStore } = require('../lib/reader-store');
const { ask, numberLines } = require('../lib/reader-model');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reader-test-'));
}

describe('ReaderStore — open', () => {
  let dir, store;
  beforeEach(() => { dir = tmpDir(); store = createReaderStore({ dir }); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('opens inline text: id format, byte-identical spill, meta fields', () => {
    const text = 'line one\nline\ttwo\nline three ';
    const r = store.open({ text }, 'test briefing');
    expect(r.id).toMatch(/^ctx_[0-9a-f]{8}$/);
    expect(fs.readFileSync(path.join(dir, `${r.id}.txt`), 'utf8')).toBe(text); // byte-identical
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${r.id}.meta.json`), 'utf8'));
    expect(meta.briefing).toBe('test briefing');
    expect(meta.size).toBe(Buffer.byteLength(text));
    expect(meta.lines).toBe(3);
    expect(meta.source).toEqual({ text: 'inline' });
    expect(r.tooLargeForAsk).toBe(false);
  });

  test('opens a file by path', () => {
    const p = path.join(dir, 'src.log');
    fs.writeFileSync(p, 'a\nb\nc');
    const r = store.open({ path: p }, 'log check');
    expect(r.lines).toBe(3);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${r.id}.meta.json`), 'utf8'));
    expect(meta.source).toEqual({ path: p });
  });

  test('XOR violation and missing briefing throw', () => {
    expect(() => store.open({ }, 'b')).toThrow(/exactly one/);
    expect(() => store.open({ path: '/x', text: 'y' }, 'b')).toThrow(/exactly one/);
    expect(() => store.open({ text: 'x' }, '')).toThrow(/briefing/);
  });

  test('ENOENT propagates for a missing path', () => {
    expect(() => store.open({ path: path.join(dir, 'nope.txt') }, 'b')).toThrow(/ENOENT/);
  });

  test('>ASK_MAX opens but is flagged tooLargeForAsk; canAsk gates it', () => {
    const big = 'x'.repeat(store.limits.ASK_MAX + 10);
    const r = store.open({ text: big }, 'big');
    expect(r.tooLargeForAsk).toBe(true);
    const gate = store.canAsk(store.get(r.id));
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/reader_peek/);
  });

  test('>OPEN_MAX rejected outright', () => {
    const huge = 'x'.repeat(store.limits.OPEN_MAX + 1);
    expect(() => store.open({ text: huge }, 'b')).toThrow(/too large/);
  });
});

describe('ReaderStore — preview & peek', () => {
  let dir, store;
  beforeEach(() => { dir = tmpDir(); store = createReaderStore({ dir }); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('preview: head 20 + tail 10 with omission marker on long docs', () => {
    const text = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join('\n');
    const r = store.open({ text }, 'b');
    expect(r.preview).toContain('1\tL1');
    expect(r.preview).toContain('20\tL20');
    expect(r.preview).toContain('(70 lines omitted)');
    expect(r.preview).toContain('100\tL100');
    expect(r.preview).not.toContain('50\tL50');
  });

  test('short doc preview has no omission marker', () => {
    const r = store.open({ text: 'a\nb' }, 'b');
    expect(r.preview).not.toContain('omitted');
  });

  test('peek returns verbatim numbered slice (tabs/trailing spaces preserved)', () => {
    const text = 'one\n\ttabbed  \nthree\nfour';
    const r = store.open({ text }, 'b');
    expect(store.peek(r.id, 2, 3)).toBe('2\t\ttabbed  \n3\tthree');
  });

  test('peek clamps out-of-range and rejects inverted/oversized spans', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `L${i + 1}`).join('\n');
    const r = store.open({ text }, 'b');
    expect(store.peek(r.id, 998, 5000)).toContain('1000\tL1000'); // clamp end
    expect(() => store.peek(r.id, 10, 5)).toThrow(/start_line/);
    expect(() => store.peek(r.id, 1, 500)).toThrow(/max 400/);
    expect(() => store.peek('ctx_00000000', 1, 2)).toThrow(/no reader/);
  });
});

describe('ReaderStore — spill/reload, lifecycle', () => {
  let dir, store;
  beforeEach(() => { dir = tmpDir(); store = createReaderStore({ dir }); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a new store instance over the same dir rehydrates an entry', () => {
    const r = store.open({ text: 'persist me' }, 'briefing-x');
    const store2 = createReaderStore({ dir });
    const e = store2.get(r.id);
    expect(e).not.toBeNull();
    expect(e.meta.briefing).toBe('briefing-x');
    expect(e.haikuSid).toBeNull();      // the dialog does not survive
    expect(e.rehydrated).toBe(true);
    expect(store2.peek(r.id, 1, 1)).toBe('1\tpersist me');
  });

  test('corrupted meta.json → treated as missing', () => {
    const r = store.open({ text: 'x' }, 'b');
    fs.writeFileSync(path.join(dir, `${r.id}.meta.json`), '{broken');
    const store2 = createReaderStore({ dir });
    expect(store2.get(r.id)).toBeNull();
  });

  test('close frees a slot and is idempotent', () => {
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(store.open({ text: `d${i}` }, 'b').id);
    expect(store.close(ids[0])).toBe(true);
    expect(store.close(ids[0])).toBe(false); // idempotent
    expect(fs.existsSync(path.join(dir, `${ids[0]}.txt`))).toBe(false);
    // the slot was freed manually — nothing needs to be evicted
    expect(store.open({ text: 'now fits' }, 'b').evicted).toBeNull();
  });

  // Regression for context hygiene silently switching off: if the 11th open threw,
  // intercept-hook would swallow the exception (fail-open) and the large output would
  // go into the agent's window whole, without any signal. Overflow evicts the LRU entry
  // and does so loudly — both in the log and in the returned field.
  test('the 11th open evicts the least recently used reader instead of throwing', () => {
    const logged = [];
    const s = createReaderStore({ dir, log: (m) => logged.push(m) });
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(s.open({ text: `d${i}` }, 'b').id);
    // touch the oldest (peek) and a middle one (get): the victim must NOT be either,
    // otherwise it would be FIFO by open time rather than LRU by access time
    s.peek(ids[0], 1, 1);
    s.get(ids[5]);

    let r;
    expect(() => { r = s.open({ text: 'over' }, 'b'); }).not.toThrow();

    expect(r.evicted).toBe(ids[1]);                  // the least recently used, not ids[0]
    const openIds = s.list().map((e) => e.id);
    expect(openIds).toHaveLength(10);                // exactly the limit, not 11
    expect(openIds).toEqual(expect.arrayContaining([ids[0], ids[5], r.id]));
    expect(openIds).not.toContain(ids[1]);
    // the victim's raw file is removed from disk just like a regular close — no files pile up
    expect(fs.existsSync(path.join(dir, `${ids[1]}.txt`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${ids[1]}.meta.json`))).toBe(false);
    expect(s.get(ids[1])).toBeNull();
    // loudness: the victim id must be in the log
    expect(logged.join('\n')).toContain(ids[1]);
  });

  test('eviction repeats and always hits the least recently used reader', () => {
    const s = createReaderStore({ dir, log: () => {} });
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(s.open({ text: `d${i}` }, 'b').id);
    expect(s.open({ text: 'a' }, 'b').evicted).toBe(ids[0]);
    expect(s.open({ text: 'b' }, 'b').evicted).toBe(ids[1]);
    expect(s.list()).toHaveLength(10);
  });

  test('48h sweep removes old files, keeps fresh (injected clock)', () => {
    let t = 1_000_000_000_000;
    const clockStore = createReaderStore({ dir, now: () => t });
    const r = clockStore.open({ text: 'old' }, 'b');
    // age the file mtime directly
    const old = new Date(t - 49 * 3600 * 1000);
    fs.utimesSync(path.join(dir, `${r.id}.txt`), old, old);
    fs.utimesSync(path.join(dir, `${r.id}.meta.json`), old, old);
    const removed = clockStore.sweep();
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(dir, `${r.id}.txt`))).toBe(false);
  });

  test('list reports open readers with briefing and ask count', () => {
    const r = store.open({ text: 'doc' }, 'why I read this');
    const l = store.list();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ id: r.id, briefing: 'why I read this', asks: 0 });
  });
});

describe('reader-model.ask with fake transport', () => {
  let dir, store;
  beforeEach(() => { dir = tmpDir(); store = createReaderStore({ dir }); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('first ask sends framing+briefing+numbered doc; follow-up resumes with bare question', async () => {
    const r = store.open({ text: 'alpha\nbeta' }, 'find the beta');
    const entry = store.get(r.id);
    const calls = [];
    const fake = async (prompt, sid) => { calls.push({ prompt, sid }); return { out: 'answer\nNOTICED: nothing new', sid: 'sid-1' }; };

    await ask(store, entry, 'where is beta?', fake);
    expect(calls[0].sid).toBeNull();
    expect(calls[0].prompt).toContain('NOTICED');               // framing
    expect(calls[0].prompt).toContain('find the beta');          // briefing
    expect(calls[0].prompt).toContain('2\tbeta');                // numbered document
    expect(calls[0].prompt).toContain('where is beta?');
    expect(entry.haikuSid).toBe('sid-1');
    expect(entry.asks).toBe(1);

    await ask(store, entry, 'second q', fake);
    expect(calls[1].prompt).toBe('second q');                    // resume — without the document
    expect(calls[1].sid).toBe('sid-1');
  });

  test('transport error does not corrupt state; retry re-sends the doc', async () => {
    const r = store.open({ text: 'doc' }, 'b');
    const entry = store.get(r.id);
    const boom = async () => { throw new Error('network'); };
    await expect(ask(store, entry, 'q', boom)).rejects.toThrow('network');
    expect(entry.haikuSid).toBeNull();
    expect(entry.asks).toBe(0);
    const ok = async (prompt) => ({ out: 'fine', sid: 's2' });
    await expect(ask(store, entry, 'q', ok)).resolves.toBe('fine');
    expect(entry.asks).toBe(1);
  });

  test('canAsk gate blocks oversized docs before any transport call', async () => {
    const big = 'x'.repeat(store.limits.ASK_MAX + 1);
    const r = store.open({ text: big }, 'b');
    const entry = store.get(r.id);
    const fake = jest.fn();
    await expect(ask(store, entry, 'q', fake)).rejects.toThrow(/reader_peek/);
    expect(fake).not.toHaveBeenCalled();
  });

  test('numberLines is 1-based with tabs', () => {
    expect(numberLines('a\nb')).toBe('1\ta\n2\tb');
  });
});

// A single store may serve several sessions; the document owner separates the limit,
// list and close. Without it, a large output in one session would evict another session's
// documents, and reader_list/reader_close would see and touch other sessions' documents.
describe('ReaderStore — document owner', () => {
  let dir, store;
  beforeEach(() => { dir = tmpDir(); store = createReaderStore({ dir, log: () => {} }); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('limit and eviction are per owner: 10 documents of another owner do not evict mine', () => {
    const mine = store.open({ text: 'my doc' }, 'b', { owner: 'A' });
    for (let i = 0; i < 12; i++) store.open({ text: `b${i}` }, 'b', { owner: 'B' });
    expect(store.list({ owner: 'A' }).map(e => e.id)).toEqual([mine.id]);
    expect(store.list({ owner: 'B' })).toHaveLength(store.limits.MAX_OPEN);
  });

  test('eviction within an owner hits that owner\'s least recently used reader', () => {
    const first = store.open({ text: 'a0' }, 'b', { owner: 'A' });
    for (let i = 1; i < store.limits.MAX_OPEN; i++) store.open({ text: `a${i}` }, 'b', { owner: 'A' });
    const r = store.open({ text: 'a-extra' }, 'b', { owner: 'A' });
    expect(r.evicted).toBe(first.id);
  });

  test('list({owner}) — only own documents; no argument — all', () => {
    store.open({ text: 'x' }, 'b', { owner: 'A' });
    store.open({ text: 'y' }, 'b', { owner: 'B' });
    expect(store.list({ owner: 'A' })).toHaveLength(1);
    expect(store.list()).toHaveLength(2);
  });

  test('closing another owner\'s document is refused, own and ownerless ones close; owner survives a restart', () => {
    const b = store.open({ text: 'y' }, 'b', { owner: 'B' });
    expect(() => store.close(b.id, { owner: 'A' })).toThrow(/another session/);
    const store2 = createReaderStore({ dir, log: () => {} }); // "restart": empty map, meta on disk
    expect(() => store2.close(b.id, { owner: 'A' })).toThrow(/another session/);
    expect(store2.close(b.id, { owner: 'B' })).toBe(true);
    const legacy = store2.open({ text: 'z' }, 'b');          // legacy document without an owner
    expect(store2.close(legacy.id, { owner: 'A' })).toBe(true);
  });

  test('reading by id is not restricted by owner (a handoff successor reads the parent\'s document)', () => {
    const b = store.open({ text: 'l1\nl2' }, 'b', { owner: 'B' });
    expect(store.peek(b.id, 1, 2)).toBe('1\tl1\n2\tl2');
  });
});
