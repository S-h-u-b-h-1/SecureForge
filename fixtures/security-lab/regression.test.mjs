import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readNote } from './vulnerable/storage.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sf-notes-'));
  const root = path.join(directory, 'notes');
  mkdirSync(root);
  writeFileSync(path.join(root, 'inside.txt'), 'permitted note');
  writeFileSync(path.join(directory, 'outside.txt'), 'outside fixture data');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { root, outside: path.join(directory, 'outside.txt') };
}

test('permitted notes remain readable', t => {
  const { root } = fixture(t);
  assert.equal(readNote(root, 'inside.txt'), 'permitted note');
});

test('a parent-directory path cannot read outside the notes root', t => {
  const { root } = fixture(t);
  assert.throws(() => readNote(root, '../outside.txt'));
});

test('an absolute path cannot read outside the notes root', t => {
  const { root, outside } = fixture(t);
  assert.throws(() => readNote(root, outside));
});

test('a symlink cannot read outside the notes root', t => {
  const { root, outside } = fixture(t);
  symlinkSync(outside, path.join(root, 'link.txt'));
  assert.throws(() => readNote(root, 'link.txt'));
});
