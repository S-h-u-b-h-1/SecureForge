import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
