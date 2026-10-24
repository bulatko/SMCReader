/**
 * Unit: store over a shared directory — disk is the source of truth, the id never becomes a path.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReaderStore } = require('../lib/reader-store');

let root; let dir;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-disk-')); dir = path.join(root, 'store'); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const quiet = { log: () => {} };

test('close/get with a path-like id do not touch files outside the directory', () => {
  const s = createReaderStore({ dir, ...quiet });
  const victim = path.join(root, 'secret.txt');
  fs.writeFileSync(victim, 'keep');
  fs.writeFileSync(path.join(root, 'secret.meta.json'), '{}');
  expect(s.close('../secret')).toBe(false);
  expect(s.get('../secret')).toBeNull();
  expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
});

test('a document closed by another store (process) disappears from this one too', () => {
  const a = createReaderStore({ dir, ...quiet });
  const b = createReaderStore({ dir, ...quiet });
  const { id } = a.open({ text: 'x\ny' }, 'brief');
  expect(b.get(id)).not.toBeNull();
  expect(b.list().map((d) => d.id)).toEqual([id]);
  a.close(id);
  expect(b.get(id)).toBeNull();
  expect(b.list()).toEqual([]);
  expect(() => b.peek(id, 1, 1)).toThrow(/no reader/);
});

test('access updates file mtime — sweeping does not remove a document in use', () => {
  let t = Date.now();
  const s = createReaderStore({ dir, now: () => t, ...quiet });
  const { id } = s.open({ text: 'x' }, 'brief');
  t += 47 * 3600 * 1000;
  s.get(id);                                     // access one hour before the TTL
  t += 2 * 3600 * 1000;                          // 49 h since open, 2 h since access
  expect(s.sweep()).toBe(0);
  expect(s.peek(id, 1, 1)).toBe('1\tx');
});
