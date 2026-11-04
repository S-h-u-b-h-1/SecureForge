import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from '../src/workspace.mjs';
import { discoverRelevantFiles } from '../src/build/repository-discovery.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'secureforge-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new Map([
    ['src/auth/login.py', 'from .tokens import verify_token\ndef login(request):\n    return verify_token(request.token)\n'],
    ['src/auth/tokens.py', 'def verify_token(token):\n    return token is not None\n'],
    ['tests/test_login.py', 'from src.auth.login import login\ndef test_login():\n    assert login\n'],
    ['web/src/app.js', "import { authenticate } from '../lib/auth.js';\nexport const app = authenticate;\n"],
    ['web/lib/auth.js', 'export function authenticate() { return true; }\n'],
    ['src/config.yaml', 'password = privatecredential\n'],
    ['docs/unrelated.md', 'Documentation about unrelated release work.\n'],
    ['scripts/valid.sh', 'echo ok\n'],
  ]);
  for (const [file, content] of source) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  await writeFile(path.join(root, '.env'), 'password = ANOTHER_SECRET\n');
  await symlink('/etc/hosts', path.join(root, 'src/auth/evil.py'));
  const workspace = await new Workspace(root).init();
  t.after(() => workspace.close?.());
  return { root, workspace, source };
}

test('B1 ranks task-relevant files, provides SHA-256 evidence, and changes nothing on disk', async (t) => {
  const { root, workspace, source } = await fixture(t);
  const result = await discoverRelevantFiles({ workspace, task: 'Fix login token verification', maxCandidates: 6 });
  assert.equal(result.schemaVersion, 1);
  assert.ok(result.candidates.length >= 2);
  assert.equal(result.candidates[0].path, 'src/auth/login.py');
  assert.ok(result.candidates.some((x) => x.path === 'src/auth/tokens.py'));
  assert.ok(result.candidates.some((x) => x.path === 'tests/test_login.py'));
  for (const entry of result.candidates) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.evidence.length <= 3);
    assert.ok(entry.evidence.every((x) => x.excerpt.length <= 160 && Number.isInteger(x.line)));
  }
  for (const [filename, content] of source) assert.equal(await readFile(path.join(root, filename), 'utf8'), content);
});

test('B1 resolves only literal local Python and JS import relationships', async (t) => {
  const { workspace } = await fixture(t);
  const a = await discoverRelevantFiles({ workspace, task: 'Fix token verification login', maxCandidates: 12 });
  const login = a.candidates.find((x) => x.path === 'src/auth/login.py');
  const token = a.candidates.find((x) => x.path === 'src/auth/tokens.py');
  assert.ok(login.imports.some((x) => x.path === 'src/auth/tokens.py'));
  assert.ok(token.importedBy.some((x) => x.path === 'src/auth/login.py'));
  const b = await discoverRelevantFiles({ workspace, task: 'Refactor authenticate auth', maxCandidates: 12 });
  assert.ok(b.candidates.find((x) => x.path === 'web/src/app.js')?.imports.some((x) => x.path === 'web/lib/auth.js'));
});

test('B1 excludes secret-bearing and unsafe/symlink files from model evidence', async (t) => {
  const { workspace } = await fixture(t);
  const result = await discoverRelevantFiles({ workspace, task: 'Fix password login auth', maxCandidates: 20 });
  assert.equal(result.candidates.some((x) => x.path === '.env'), false);
  assert.equal(result.candidates.some((x) => x.path === 'src/auth/evil.py'), false);
  assert.equal(result.candidates.some((x) => x.path === 'src/config.yaml'), false);
  assert.ok(result.coverage.redactedFiles >= 1);
  assert.ok(!JSON.stringify(result).includes('privatecredential'));
  assert.ok(!JSON.stringify(result).includes('ANOTHER_SECRET'));
});

test('B1 is deterministic and bounded, with explicit coverage', async (t) => {
  const { workspace } = await fixture(t);
  const a = await discoverRelevantFiles({ workspace, task: 'Fix login token verification', maxFiles: 5, maxCandidates: 2, maxEvidenceLines: 1 });
  const b = await discoverRelevantFiles({ workspace, task: 'Fix login token verification', maxFiles: 5, maxCandidates: 2, maxEvidenceLines: 1 });
  assert.deepEqual(a, b);
  assert.ok(a.candidates.length <= 2);
  assert.ok(a.candidates.every((entry) => entry.evidence.length <= 1));
  assert.ok(a.coverage.listedFiles <= 5);
  assert.equal(a.coverage.mayBeCapped, true);
});

test('B1 validates task, limits, and workspace adapter and permits cancellation', async (t) => {
  const { workspace } = await fixture(t);
  await assert.rejects(discoverRelevantFiles({ workspace, task: 'an and or' }), /searchable term/);
  await assert.rejects(discoverRelevantFiles({ workspace, task: 'x' }), /task must/);
  await assert.rejects(discoverRelevantFiles({ workspace, task: 'login', maxFiles: 5000 }), /maxFiles/);
  await assert.rejects(discoverRelevantFiles({ workspace, task: 'login', maxCandidates: 0 }), /maxCandidates/);
  await assert.rejects(discoverRelevantFiles({ workspace: {}, task: 'login' }), /secure Workspace/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverRelevantFiles({ workspace, task: 'login', signal: controller.signal }), /cancelled/);
});


test('B1 excludes credential-bearing filenames and directories before returning path evidence', async (t) => {
  const { root, workspace } = await fixture(t);
  const token = 'ghp_abcdefghijklmnopqrstuv';
  const secretFilename = `src/auth/login-${token}.js`;
  const secretDirectory = `src/${token}/login.js`;
  await writeFile(path.join(root, secretFilename), 'export function login() {}\n');
  await mkdir(path.dirname(path.join(root, secretDirectory)), { recursive: true });
  await writeFile(path.join(root, secretDirectory), 'export function login() {}\n');
  const output = await discoverRelevantFiles({ workspace, task: 'Fix login token authentication', maxCandidates: 20 });
  assert.ok(!JSON.stringify(output).includes(token), 'Credential must not appear in any discovery output');
  assert.ok(!output.candidates.some(({ path: name }) => name === secretFilename || name === secretDirectory));
  assert.ok(!(await workspace.listFiles()).some(file => file.includes(token)));
  const adapter = {
    listFiles: async () => [...await workspace.listFiles(), secretFilename, secretDirectory],
    readFile: (...args) => workspace.readFile(...args),
  };
  const adapterOutput = await discoverRelevantFiles({ workspace: adapter, task: 'login token verification', maxCandidates: 20 });
  assert.ok(adapterOutput.coverage.redactedFiles >= 2);
  assert.ok(!JSON.stringify(adapterOutput).includes(token));
});

test('B1 cancellation after listFiles and readFile does not return success', async () => {
  const afterList = new AbortController();
  const adapterList = {
    async listFiles() { afterList.abort(); return []; },
    async readFile() { throw new Error('Should not read after cancellation'); },
  };
  await assert.rejects(
    discoverRelevantFiles({ workspace: adapterList, task: 'Fix login', signal: afterList.signal }),
    /cancelled/
  );
  const afterRead = new AbortController();
  const adapterRead = {
    async listFiles() { return ['app.js']; },
    async readFile() {
      afterRead.abort();
      return { path: 'app.js', sha256: 'a'.repeat(64), redacted: false, truncated: false,
        lines: [{ line: 1, text: 'function login() {}' }] };
    },
  };
  await assert.rejects(
    discoverRelevantFiles({ workspace: adapterRead, task: 'Fix login', signal: afterRead.signal }),
    /cancelled/
  );
  const readReject = new AbortController();
  const adapterReject = {
    async listFiles() { return ['app.js']; },
    async readFile() { readReject.abort(); throw new Error('ENOENT'); },
  };
  await assert.rejects(
    discoverRelevantFiles({ workspace: adapterReject, task: 'Fix login', signal: readReject.signal }),
    /cancelled/
  );
});

test('B1 never uses direct filesystem APIs, commands or proposal writes', async () => {
  const calls = [];
  const adapter = {
    async listFiles(args) { calls.push(['listFiles', args]); return ['app.js']; },
    async readFile(file, args) {
      calls.push(['readFile', file, args]);
      return { path: 'app.js', sha256: 'a'.repeat(64), redacted: false, truncated: false,
        lines: [{ line: 1, text: 'export function login() {}' }] };
    },
  };
  const r = await discoverRelevantFiles({ workspace: adapter, task: 'Fix login' });
  assert.deepEqual(calls.map((x) => x[0]), ['listFiles', 'readFile']);
  assert.equal(r.candidates[0].path, 'app.js');
});
