import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace, sha256 } from '../src/workspace.mjs';
import { readSourceBundle } from '../src/build/source-bundle.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'secureforge-b2-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  const sources = new Map([
    ['src/main.py', 'def config():\r\n    return {}\r\n'],
    ['tests/test_main.py', 'def test_config():\n    assert True\n'],
    ['docs/config.rst', 'Config\n======\n'],
  ]);
  for (const [name, content] of sources) await writeFile(path.join(root, name), content);
  const workspace = await new Workspace(root).init();
  t.after(() => workspace.close?.());
  return { workspace, root, sources };
}

test('B2 bundle returns three complete hashed sources preserving CRLF and unchanged files', async t => {
  const { workspace, root, sources } = await fixture(t);
  const r = await readSourceBundle({ workspace, paths: [...sources.keys()] });
  assert.equal(r.fileCount, 3);
  assert.equal(r.status, 'read_only');
  assert.equal(r.totalBytes, [...sources.values()].reduce((n, s) => n + Buffer.byteLength(s), 0));
  for (const item of r.files) {
    const original = sources.get(item.path);
    assert.equal(item.content, original);
    assert.equal(item.sha256, sha256(original));
    assert.equal(await readFile(path.join(root, item.path), 'utf8'), original);
  }
  assert.ok(r.files[0].content.includes('\r\n'));
});

test('B2 bundle accepts exact content within 96 KiB but refuses oversized aggregate', async t => {
  const { workspace, root } = await fixture(t);
  await writeFile(path.join(root, 'src/large.py'), 'x'.repeat(96 * 1024 - 20));
  const good = await readSourceBundle({ workspace, paths: ['src/large.py'] });
  assert.equal(good.totalBytes, 96 * 1024 - 20);
  await assert.rejects(readSourceBundle({ workspace, paths: ['src/large.py', 'docs/config.rst', 'tests/test_main.py', 'src/main.py'] }), /96 KiB/);
});

test('B2 bundle excludes credential-bearing contents and path names entirely', async t => {
  const { workspace, root } = await fixture(t);
  await writeFile(path.join(root, 'src/secure.py'), 'api_key = verysecretvalue\n');
  const tokenPath = 'src/login-ghp_abcdefghijklmnopqrstuv.js';
  await writeFile(path.join(root, tokenPath), 'export function login() {}\n');
  await assert.rejects(readSourceBundle({ workspace, paths: ['src/secure.py'] }), /Credential-bearing source excluded/);
  await assert.rejects(readSourceBundle({ workspace, paths: [tokenPath] }), /Credential-bearing path excluded/);
  await assert.rejects(readSourceBundle({ workspace, paths: ['docs/config.rst', 'src/secure.py'] }), /Credential-bearing source excluded/);
});

test('B2 bundle rejects traversal, symlinks, duplicate/casefold paths and unknown files', async t => {
  const { workspace, root } = await fixture(t);
  await symlink('/etc/hosts', path.join(root, 'src/hosts.py'));
  await symlink('src', path.join(root, 'linked'));
  await writeFile(path.join(root, '.env'), 'password = synthetic_value\n');
  await assert.rejects(readSourceBundle({ workspace, paths: ['../secret.py'] }), /canonical/);
  await assert.rejects(readSourceBundle({ workspace, paths: ['src\\main.py'] }), /canonical/);
  await assert.rejects(readSourceBundle({ workspace, paths: ['src/main.py', 'SRC/MAIN.PY'] }), /Duplicate/);
  await assert.rejects(readSourceBundle({ workspace, paths: ['src/hosts.py'] }), /workspace read policy/);
  await assert.rejects(readSourceBundle({ workspace, paths: ['linked/main.py'] }), /workspace read policy/);
  await assert.rejects(readSourceBundle({ workspace, paths: ['src/missing.py'] }), /workspace read policy/);
  await assert.rejects(readSourceBundle({ workspace, paths: ['.env'] }), /workspace read policy/);
});

test('B2 bundle fails on invalid hash or file identity from an untrusted adapter', async () => {
  const bad = {
    async rawForProposal(path) { return { relative: path, raw: 'code\n', hash: 'f'.repeat(64) }; },
  };
  await assert.rejects(readSourceBundle({ workspace: bad, paths: ['src/main.py'] }), /inconsistent workspace data/);
  await assert.rejects(readSourceBundle({ workspace: {}, paths: ['src/main.py'] }), /Workspace.rawForProposal/);
  await assert.rejects(readSourceBundle({ workspace: bad, paths: [] }), /1..4/);
});

test('B2 bundle fails closed on cancellation after successful and failed asynchronous reads', async () => {
  const abortedAfterRead = new AbortController();
  const good = {
    async rawForProposal(name) {
      abortedAfterRead.abort();
      return { relative: name, raw: 'code\n', hash: sha256('code\n') };
    },
  };
  await assert.rejects(readSourceBundle({ workspace: good, paths: ['main.py'], signal: abortedAfterRead.signal }), /cancelled/);
  const abortedAfterError = new AbortController();
  const bad = {
    async rawForProposal() { abortedAfterError.abort(); throw new Error('private filesystem error'); },
  };
  await assert.rejects(readSourceBundle({ workspace: bad, paths: ['main.py'], signal: abortedAfterError.signal }), /cancelled/);
});

test('B2 bundle performs only secure Workspace reads and no writes or command execution', async () => {
  const calls = [];
  const raw = 'hello\n';
  const adapter = {
    async rawForProposal(path) { calls.push(path); return { relative: path, raw, hash: sha256(raw) }; },
  };
  const result = await readSourceBundle({ workspace: adapter, paths: ['src/hello.py'] });
  assert.equal(result.files[0].content, raw);
  assert.deepEqual(calls, ['src/hello.py']);
});
