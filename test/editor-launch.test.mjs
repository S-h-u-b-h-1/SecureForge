import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

test('VS Code editor-host launcher does not block on the window-closing --wait flag', async () => {
  const source = await readFile(new URL('editor/launch.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const child = spawn(executable, [');
  const end = source.indexOf("], { stdio: 'inherit'", start);
  assert.ok(start >= 0 && end > start, 'The editor launcher should use an explicit argument list');
  const args = source.slice(start, end);
  assert.doesNotMatch(args, /['"]--wait['"]/, 'The test host must exit after --extensionTestsPath completes');
  assert.match(args, /--extensionTestsPath=/);
  assert.match(args, /--extensionDevelopmentPath=/);
  assert.match(args, /--user-data-dir/);
  assert.match(source, /configuredTimeout/, 'Stalled editor tests must have an explicit watchdog');
});

test('launcher waits for a delayed real test report after a mock VS Code CLI exits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-launcher-mock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'fake-code');
  const fake = [
    '#!/usr/bin/env node',
    "const { spawn } = require('node:child_process');",
    "const worker = \"setTimeout(() => require('node:fs').writeFileSync(process.env.SECUREFORGE_EDITOR_REPORT, JSON.stringify({passed: ['mock editor host completed']})), 120)\";",
    "spawn(process.execPath, ['-e', worker], { stdio: 'ignore', detached: true, env: process.env }).unref();",
  ].join('\n');
  await writeFile(cli, fake, { mode: 0o755 });
  const launcher = fileURLToPath(new URL('editor/launch.mjs', import.meta.url));
  const { stdout, stderr } = await execFileAsync(process.execPath, [launcher], {
    env: { ...process.env, SECUREFORGE_CODE_PATH: cli, SECUREFORGE_EDITOR_TIMEOUT_MS: '30000' },
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  assert.match(stdout, /PASS mock editor host completed/);
  assert.doesNotMatch(stderr, /Editor verification failed/);
});

test('launcher reports CLI failure rather than a misleading report ENOENT', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-launcher-mock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, 'fake-code');
  await writeFile(cli, '#!/usr/bin/env node\nprocess.exit(3);\n', { mode: 0o755 });
  const launcher = fileURLToPath(new URL('editor/launch.mjs', import.meta.url));
  await assert.rejects(execFileAsync(process.execPath, [launcher], {
    env: { ...process.env, SECUREFORGE_CODE_PATH: cli, SECUREFORGE_EDITOR_TIMEOUT_MS: '30000' },
    timeout: 10000,
  }), error => {
    assert.match(String(error.stderr), /VS Code test CLI exited with code 3/);
    assert.doesNotMatch(String(error.stderr), /ENOENT: no such file/);
    return true;
  });
});
