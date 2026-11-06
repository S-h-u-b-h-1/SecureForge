import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace, sha256 } from '../src/workspace.mjs';
import { assembleContext, parseMentions, validateInlineProposal, detectWorkspaceMismatch } from '../src/context.mjs';

test('context discovers implementation/tests/docs without named files and respects a byte budget', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-context-'));
  for (const directory of ['src', 'tests', 'docs', '.tmp']) await mkdir(path.join(root, directory));
  for (const [file, content] of Object.entries({
    'src/cli.py': 'def config_command():\n    return "loaded config"\n',
    'tests/test_cli.py': 'def test_config_command():\n    assert True\n',
    'docs/cli.rst': 'Built-in CLI commands\nConfiguration command reference\n',
    'src/unrelated.py': 'def bicycle():\n    pass\n',
    '.tmp/cli.py': 'private generated scratch data',
  })) await writeFile(path.join(root, file), content);
  const workspace = await new Workspace(root).init();
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  const result = await assembleContext(workspace, 'Add a CLI config command with tests and docs', { budgetBytes: 2000 });
  assert.deepEqual(new Set(result.sources.map(source => source.path)), new Set(['src/cli.py', 'tests/test_cli.py', 'docs/cli.rst']));
  assert.ok(result.sources.every(source => source.reason && source.sha256 && source.startLine >= 1));
  assert.equal(result.usedBytes, Buffer.byteLength(JSON.stringify(result.sources)));
  assert.ok(result.usedBytes <= result.budgetBytes);
  const explicit = await assembleContext(workspace, '@file:src/unrelated.py @symbol:config_command');
  assert.equal(explicit.sources[0].path, 'src/unrelated.py');
  const invalid = await assembleContext(workspace, '@file:../outside.py config');
  assert.ok(invalid.skipped.some(item => item.path === '../outside.py'));
});

test('mentions support quoted paths and inline scope rejects unrelated edits', () => {
  assert.deepEqual(parseMentions('@file:"source files/a.py" @symbol:readNote'), { files: ['source files/a.py'], symbols: ['readNote'] });
  const originalContent = 'before\nold\nafter\n';
  const selection = { path: 'file.py', startOffset: 7, endOffset: 10, baseSha256: sha256(originalContent) };
  const proposal = { path: 'file.py', baseSha256: selection.baseSha256, originalContent, proposedContent: 'before\nNEW\nafter\n' };
  assert.doesNotThrow(() => validateInlineProposal(selection, proposal));
  assert.throws(() => validateInlineProposal(selection, { ...proposal, proposedContent: 'BEFORE\nNEW\nafter\n' }), /outside/);
  assert.throws(() => validateInlineProposal(selection, { ...proposal, path: 'other.py' }), /another file/);
});

test('context excludes credential-bearing paths from discovery, mentions, selections and diagnostics', async () => {
  const token = 'ghp_abcdefghijklmnopqrstuv';
  const sensitive = `src/login-${token}.js`;
  const safe = 'src/login.js';
  const raw = 'export function login() {}\n';
  for (const scenario of ['listed', 'explicit', 'selected', 'unreadable', 'returned-path']) {
    const reads = [];
    const workspace = {
      listFiles: async () => ['listed', 'unreadable'].includes(scenario) ? [sensitive, safe] : [safe],
      rawForProposal: async file => {
        reads.push(file);
        if (scenario === 'unreadable' && file === sensitive) throw new Error('Denied');
        return { relative: scenario === 'returned-path' ? sensitive : file, raw, hash: sha256(raw) };
      },
    };
    const task = scenario === 'explicit' ? `Fix login @file:"${sensitive}"` : 'Fix login response';
    const result = await assembleContext(workspace, task, {
      budgetBytes: 2000, selectedPath: scenario === 'selected' ? sensitive : undefined,
    });
    assert.equal(JSON.stringify(result).includes(token), false, scenario);
    assert.equal(reads.includes(sensitive), false, `${scenario} must exclude paths before reading`);
    if (scenario !== 'returned-path') assert.ok(result.sources.some(source => source.path === safe));
  }
  const mentions = parseMentions(`@file:${sensitive} @symbol:${token} @file:${safe} @symbol:login`);
  assert.deepEqual(mentions, { files: [safe], symbols: ['login'] });
});

test('context skips complete credential-bearing source bodies including explicitly attached files', async () => {
  const token = 'ghp_abcdefghijklmnopqrstuv';
  const safeRaw = 'export function login() {}\n';
  const unsafeRaw = `// ${token}\nexport function login() {}\n`;
  const workspace = {
    listFiles: async () => ['src/login.js', 'src/clean.js'],
    rawForProposal: async file => ({ relative: file, raw: file === 'src/login.js' ? unsafeRaw : safeRaw, hash: sha256(file) }),
  };
  const result = await assembleContext(workspace, 'Fix login @file:src/login.js', { budgetBytes: 2000 });
  assert.deepEqual(result.sources.map(source => source.path), ['src/clean.js']);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.ok(result.skipped.some(item => item.path === 'src/login.js' && /credential/i.test(item.reason)));
});

test('Flask-specific existing-code requests in a Node-only workspace stop before source reads', async () => {
  const task = 'Fix FLASK_DEBUG and FLASK_SKIP_DOTENV parsing of off and n; add regression tests';
  const files = ['src/intelligence.js', 'server.js', 'package.json', 'tests/intelligence.test.js'];
  const mismatch = detectWorkspaceMismatch(task, files);
  assert.equal(mismatch?.code, 'FLASK_SOURCE_ABSENT');
  assert.match(mismatch.message, /Open your Flask project folder/);

  let readCount = 0;
  const workspace = {
    listFiles: async () => files,
    rawForProposal: async () => { readCount++; throw new Error('Should not read code'); },
  };
  const context = await assembleContext(workspace, task);
  assert.equal(context.workspaceMismatch?.code, 'FLASK_SOURCE_ABSENT');
  assert.deepEqual(context.sources, []);
  assert.equal(readCount, 0);
});

test('workspace mismatch guard is conservative when there is Python or a new integration request', () => {
  const task = 'Fix FLASK_DEBUG and FLASK_SKIP_DOTENV to recognize off and n';
  assert.equal(detectWorkspaceMismatch(task, ['src/flask/helpers.py', 'tests/test_helpers.py']), null);
  assert.equal(detectWorkspaceMismatch('Explain FLASK_DEBUG behavior', ['server.js']), null);
  assert.equal(detectWorkspaceMismatch('Implement a new Flask service in Node project', ['server.js']), null);
  assert.equal(detectWorkspaceMismatch(task, Array(2500).fill('src/file.js')), null);
  assert.equal(detectWorkspaceMismatch('Fix the Node server', ['server.js']), null);
});

test('Flask package subfolder is distinguished from full source checkout before contacting model', async () => {
  const task = 'Fix existing FLASK_DEBUG and FLASK_SKIP_DOTENV parsing and add regression tests';
  const packageFiles = ['__init__.py', '__main__.py', 'app.py', 'helpers.py', 'cli.py', 'json/__init__.py'];
  const mismatch = detectWorkspaceMismatch(task, packageFiles);
  assert.equal(mismatch?.code, 'FLASK_PACKAGE_SUBFOLDER');
  assert.match(mismatch.message, /two levels up/);
  let sourceReads = 0;
  const context = await assembleContext({
    listFiles: async () => packageFiles,
    rawForProposal: async () => { sourceReads++; throw new Error('Source must not be read'); },
  }, task);
  assert.equal(context.workspaceMismatch?.code, 'FLASK_PACKAGE_SUBFOLDER');
  assert.equal(sourceReads, 0);
  assert.equal(detectWorkspaceMismatch(task,
    ['pyproject.toml', 'src/flask/helpers.py', 'src/flask/cli.py', 'tests/test_helpers.py']), null);
  assert.equal(detectWorkspaceMismatch(task, ['helpers.py', 'cli.py', '__init__.py', 'pyproject.toml']), null);
  assert.equal(detectWorkspaceMismatch('Explain FLASK_DEBUG parsing', packageFiles), null);
  assert.equal(detectWorkspaceMismatch('Implement a new Flask service', packageFiles), null);
});
