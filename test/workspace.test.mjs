import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace, redactSecrets, sha256 } from '../src/workspace.mjs';
import { ProposalStore } from '../src/proposals.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'secureforge-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'auth.py'), 'def login():\n    return True\n');
  await writeFile(path.join(root, '.env'), 'TOKEN=SECRET_VALUE\n');
  await writeFile(path.join(root, 'src', 'notes.md'), 'password = superprivate\n');
  const workspace = await new Workspace(root).init();
  t.after(() => workspace.close());
  return { root, workspace };
}

test('read_file returns numbered bounded source lines and a stable hash', async (t) => {
  const { workspace } = await fixture(t);
  const res = await workspace.readFile('src/auth.py', { startLine: 1, maxLines: 2 });
  assert.equal(res.path, 'src/auth.py');
  assert.equal(res.sha256, sha256('def login():\n    return True\n'));
  assert.deepEqual(res.lines, [{ line: 1, text: 'def login():' }, { line: 2, text: '    return True' }]);
  assert.equal(res.truncated, true);
});

test('path traversal, absolute paths and sensitive files are denied', async (t) => {
  const { workspace, root } = await fixture(t);
  await assert.rejects(workspace.readFile('../foo.py'), /Unsafe path|workspace/);
  await assert.rejects(workspace.readFile(path.join(root, 'src/auth.py')), /relative/);
  await assert.rejects(workspace.readFile('.env'), /Restricted/);
  await assert.rejects(workspace.readFile('src/../../.env'), /Unsafe/);
  await assert.rejects(workspace.readFile('.git/config'), /Restricted/);
});

test('symlink escape and internal symlinks fail closed', async (t) => {
  const { workspace, root } = await fixture(t);
  await symlink('/etc/hosts', path.join(root, 'src', 'hosts.py'));
  await symlink('auth.py', path.join(root, 'src', 'alias.py'));
  await assert.rejects(workspace.readFile('src/hosts.py'), /Symlink/);
  await assert.rejects(workspace.readFile('src/alias.py'), /Symlink/);
  await symlink('src', path.join(root, 'linked-src'));
  await assert.rejects(workspace.readFile('linked-src/auth.py'), /Symlink/);
  assert.ok(!(await workspace.listFiles()).includes('src/hosts.py'));
});

test('binary and oversized files cannot enter model context', async (t) => {
  const { workspace, root } = await fixture(t);
  await writeFile(path.join(root, 'src', 'binary.py'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, 'src', 'huge.py'), 'a'.repeat(256 * 1024 + 1));
  await assert.rejects(workspace.readFile('src/binary.py'), /Binary/);
  await assert.rejects(workspace.readFile('src/huge.py'), /limit/);
});

test('literal repository search and candidate symbol lookup are bounded', async (t) => {
  const { workspace } = await fixture(t);
  const result = await workspace.searchWorkspace('login');
  assert.equal(result.matches.length, 1);
  assert.deepEqual([result.matches[0].path, result.matches[0].line], ['src/auth.py', 1]);
  assert.equal((await workspace.lookupSymbol('login')).matches.length, 1);
  await assert.rejects(workspace.searchWorkspace('a'), /2..120/);
  await assert.rejects(workspace.lookupSymbol('login('), /simple identifier/);
});

test('redaction masks some common credential patterns (best effort)', () => {
  assert.equal(redactSecrets('api_key = "abc123"'), 'api_key = "[REDACTED]"');
  assert.ok(!redactSecrets('ghp_abcdefghijklmnopqrstuv').includes('abcdefghijklmnopqrstuv'));
  assert.ok(!redactSecrets('AKIA1234567890ABCDEF').includes('AKIA1234567890ABCDEF'));
});

test('proposals never write to disk, reject stale bases and can be discarded', async (t) => {
  const { workspace, root } = await fixture(t);
  const store = new ProposalStore(workspace);
  const source = await workspace.readFile('src/auth.py');
  await assert.rejects(store.proposeEdit({ path: source.path, expectedSha256: 'a'.repeat(64), proposedContent: 'changed' }), /Stale/);
  const original = await readFile(path.join(root, 'src/auth.py'), 'utf8');
  const proposal = await store.proposeEdit({ path: source.path, expectedSha256: source.sha256, proposedContent: original + '# proposed\n', rationale: 'demo' });
  assert.equal(proposal.status, 'pending');
  assert.equal(store.getProposal(proposal.id).proposedContent, original + '# proposed\n');
  assert.equal((await store.checkProposal(proposal.id)).fresh, true);
  assert.equal(await readFile(path.join(root, 'src/auth.py'), 'utf8'), original);
  await writeFile(path.join(root, 'src/auth.py'), '# changed by human\n');
  assert.equal((await store.checkProposal(proposal.id)).fresh, false);
  assert.equal(store.discard(proposal.id), true);
  assert.throws(() => store.getProposal(proposal.id), /not found/);
});

test('files requiring redaction cannot be proposed for unsafe full-file replacement', async (t) => {
  const { workspace } = await fixture(t);
  const view = await workspace.readFile('src/notes.md');
  assert.equal(view.redacted, true);
  const store = new ProposalStore(workspace);
  await assert.rejects(store.proposeEdit({ path: 'src/notes.md', expectedSha256: view.sha256, proposedContent: 'changed' }), /redacted credentials/);
});

test('a file swapped for an outside symlink during reads never leaks outside bytes', async (t) => {
  const { workspace, root } = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'secureforge-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = path.join(root, 'src', 'swap.py');
  await writeFile(target, 'SAFE_CONTENT\n');
  const secret = path.join(outside, 'secret.py');
  await writeFile(secret, 'OUTSIDE_SECRET_SHOULD_NEVER_APPEAR\n');
  let stop = false;
  const flip = (async () => {
    for (let i = 0; i < 160 && !stop; i++) {
      await rm(target, { force: true });
      await symlink(secret, target);
      await new Promise((resolve) => setImmediate(resolve));
      await rm(target, { force: true });
      await writeFile(target, 'SAFE_CONTENT\n');
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  try {
    for (let i = 0; i < 160; i++) {
      try {
        const result = await workspace.readFile('src/swap.py');
        assert.ok(result.lines.every(({ text }) => !text.includes('OUTSIDE_SECRET')));
      } catch (error) {
        assert.ok(['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code) || /Symlink|component/.test(error.message), String(error));
      }
    }
  } finally {
    stop = true;
    await flip;
  }
});

test('read and search redact multiline credential values before slicing lines', async (t) => {
  const { root, workspace } = await fixture(t);
  await writeFile(path.join(root, 'src', 'config.yaml'), 'password:\n  superprivate\npublic: safe\n');
  const read = await workspace.readFile('src/config.yaml', { startLine: 2, maxLines: 1 });
  assert.equal(read.redacted, true);
  assert.equal(read.lines[0].line, 2);
  assert.ok(!read.lines[0].text.includes('superprivate'));
  const search = await workspace.searchWorkspace('superprivate');
  assert.equal(search.matches.length, 0);
  const masked = await workspace.searchWorkspace('[REDACTED]');
  assert.ok(masked.matches.some(x => x.snippet.includes('[REDACTED]')));
});

test('an empty credential must not swallow the next credential key', async (t) => {
  const { root, workspace } = await fixture(t);
  const sample = 'password:\napi_key: superprivate\n';
  const expected = 'password:\napi_key: [REDACTED]\n';
  assert.equal(redactSecrets(sample), expected);
  assert.equal(redactSecrets('password:\n  api_key: superprivate\n'), 'password:\n  api_key: [REDACTED]\n');
  await writeFile(path.join(root, 'src', 'adjacent.yaml'), sample);
  const read = await workspace.readFile('src/adjacent.yaml');
  assert.deepEqual(read.lines.slice(0, 2).map((x) => x.text), ['password:', 'api_key: [REDACTED]']);
  const search = await workspace.searchWorkspace('superprivate');
  assert.equal(search.matches.length, 0);
  const publicKey = await workspace.searchWorkspace('api_key');
  assert.ok(publicKey.matches.some(x => x.path === 'src/adjacent.yaml'));
});

test('quoted JSON and YAML credential keys are redacted in read/search and block proposals', async (t) => {
  const { root, workspace } = await fixture(t);
  const sample = '{"password": "superprivate", "api_key": "anothersecret"}\n';
  assert.equal(redactSecrets(sample), '{"password": "[REDACTED]", "api_key": "[REDACTED]"}\n');
  assert.equal(redactSecrets("'password': superprivate\n"), "'password': [REDACTED]\n");
  await writeFile(path.join(root, 'src', 'config.json'), sample);
  const read = await workspace.readFile('src/config.json');
  assert.equal(read.redacted, true);
  assert.ok(read.lines.every((x) => !x.text.includes('superprivate') && !x.text.includes('anothersecret')));
  const search = await workspace.searchWorkspace('superprivate');
  assert.equal(search.matches.length, 0);
  const publicKey = await workspace.searchWorkspace('password');
  assert.ok(publicKey.matches.some(x => x.path === 'src/config.json'));
  const store = new ProposalStore(workspace);
  await assert.rejects(store.proposeEdit({ path: 'src/config.json', expectedSha256: read.sha256, proposedContent: '{}' }), /redacted credentials/);
});

test('workspace search skips invalid UTF-8 rather than failing entirely', async (t) => {
  const { root, workspace } = await fixture(t);
  await writeFile(path.join(root, 'src', 'invalid.txt'), Buffer.from([0xff, 0xfe, 0x61]));
  await assert.rejects(workspace.readFile('src/invalid.txt'), /Unsupported file encoding/);
  const matches = await workspace.searchWorkspace('login');
  assert.ok(matches.matches.some((x) => x.path === 'src/auth.py'));
  const symbols = await workspace.lookupSymbol('login');
  assert.ok(symbols.matches.some((x) => x.path === 'src/auth.py'));
});


test('shared workspace interfaces exclude credential-bearing files and directories', async t => {
  const { root, workspace } = await fixture(t);
  const token = 'ghp_abcdefghijklmnopqrstuv';
  const secretFile = `src/login-${token}.js`;
  const secretDirectory = `src/${token}`;
  await writeFile(path.join(root, secretFile), 'export function login() {}\n');
  await mkdir(path.join(root, secretDirectory));
  await writeFile(path.join(root, secretDirectory, 'login.js'), 'export function login() {}\n');
  assert.ok(!(await workspace.listFiles()).some(file => file.includes(token)));
  for (const file of [secretFile, `${secretDirectory}/login.js`]) {
    await assert.rejects(workspace.readFile(file), /Restricted/);
    await assert.rejects(workspace.rawForProposal(file), /Restricted/);
  }
  assert.equal(JSON.stringify(await workspace.searchWorkspace('login')).includes(token), false);
  assert.equal(JSON.stringify(await workspace.lookupSymbol('login')).includes(token), false);
});

test('literal searches cannot distinguish hidden credential prefixes', async t => {
  const { root, workspace } = await fixture(t);
  await writeFile(path.join(root, 'src', 'oracle.py'), 'password = "ab"\npublic_value = "visible"\n');
  for (const needle of ['password = "a', 'password = "z', 'superprivate']) {
    assert.deepEqual((await workspace.searchWorkspace(needle)).matches, []);
  }
  assert.ok((await workspace.searchWorkspace('visible')).matches.some(match => match.path === 'src/oracle.py'));
});

test('workspace listing caps directory-entry work and queued directories', async t => {
  const { root, workspace } = await fixture(t);
  await mkdir(path.join(root, 'empty'));
  await assert.rejects(workspace.listFiles({ maxEntries: 1 }), /entry limit/);
  await assert.rejects(workspace.listFiles({ maxDirectories: 1 }), /directory limit/);
  await assert.rejects(workspace.listFiles({ maxEntries: 20001 }), /maxEntries/);
  await assert.rejects(workspace.listFiles({ maxDirectories: 1001 }), /maxDirectories/);
  assert.ok((await workspace.listFiles()).includes('src/auth.py'));
});

test('workspace listing and search fail closed on cancellation', async t => {
  const { workspace } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(workspace.listFiles({ signal: controller.signal }), error => error.name === 'AbortError');
  await assert.rejects(workspace.searchWorkspace('login', { signal: controller.signal }), error => error.name === 'AbortError');
  const active = new AbortController();
  const pending = workspace.listFiles({ signal: active.signal });
  active.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
});
