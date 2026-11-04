import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.mjs';
import { prepareCommand, runApprovedCommand } from '../src/commands.mjs';
import { createMcpServer } from '../src/mcp-server.mjs';

async function fixture(t, source = "console.log('verification ran');") {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-command-'));
  const workspace = await new Workspace(root).init();
  await writeFile(path.join(root, 'sample.test.mjs'), source);
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  return { workspace, request: { executable: 'node', args: ['--test', 'sample.test.mjs'] } };
}

test('verification requires approval and records the actual approved command outcome', async t => {
  const options = await fixture(t);
  const denied = await runApprovedCommand({ ...options, approve: async () => false });
  assert.equal(denied.executed, false);
  const receipt = await runApprovedCommand({ ...options, approve: async command => {
    assert.equal(command.cwd, options.workspace.root);
    assert.equal(command.sources.length, 1);
    return true;
  } });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.exitCode, 0);
  assert.match(receipt.output, /verification ran/);
});

test('shells, option injection, traversal, unknown commands and changed tests are denied', async t => {
  const options = await fixture(t);
  for (const request of [
    { executable: 'sh', args: ['-c', 'anything'] },
    { executable: 'node', args: ['--eval', 'anything'] },
    { executable: 'node', args: ['--test', '--require=evil.test.mjs'] },
    { executable: 'node', args: ['--test', '../outside.test.mjs'] },
    { executable: 'python3', args: ['-m', 'pytest', '--override-ini=test_bad.py'] },
  ]) await assert.rejects(prepareCommand(options.workspace, request));
  await assert.rejects(runApprovedCommand({ ...options, approve: async () => {
    await writeFile(path.join(options.workspace.root, 'sample.test.mjs'), 'changed');
    return true;
  } }), /changed after approval/);
});

test('verification bounds output, redacts credentials and omits provider environment', async t => {
  const options = await fixture(t, `
console.log('password=example-private-value');
console.log('provider=' + String(process.env.SECUREFORGE_TEST_CREDENTIAL));
console.log('x'.repeat(100000));
`);
  process.env.SECUREFORGE_TEST_CREDENTIAL = 'private-provider-value';
  t.after(() => delete process.env.SECUREFORGE_TEST_CREDENTIAL);
  const receipt = await runApprovedCommand({ ...options, approve: async () => true });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.truncated, true);
  assert.ok(Buffer.byteLength(receipt.output) <= 64 * 1024);
  assert.ok(!receipt.output.includes('example-private-value'));
  assert.ok(!receipt.output.includes('private-provider-value'));
});

test('verification timeout and cancellation stop a running test process', async t => {
  const options = await fixture(t, 'setInterval(() => {}, 1000);');
  const timeout = await runApprovedCommand({ ...options,
    request: { ...options.request, timeoutMs: 150 }, approve: async () => true });
  assert.equal(timeout.status, 'timed_out');
  const controller = new AbortController();
  const run = runApprovedCommand({ ...options, signal: controller.signal, approve: async () => {
    setTimeout(() => controller.abort(), 150);
    return true;
  } });
  assert.equal((await run).status, 'cancelled');
});

test('MCP command capability is opt-in and still requires local approval', async t => {
  const options = await fixture(t);
  const bridge = await createMcpServer({ root: options.workspace.root, port: 0,
    onRunCommand: (workspace, request) => runApprovedCommand({ workspace, request, approve: async () => false }),
  });
  t.after(async () => {
    bridge.server.closeAllConnections();
    await new Promise(resolve => bridge.server.close(resolve));
    await bridge.workspace.close();
  });
  async function request(method, params) {
    const response = await fetch(`http://127.0.0.1:${bridge.address.port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await response.json()).result;
  }
  const tools = await request('tools/list');
  assert.equal(tools.tools.find(tool => tool.name === 'run_command').annotations.destructiveHint, true);
  const result = await request('tools/call', { name: 'run_command', arguments: options.request });
  const receipt = JSON.parse(result.content[0].text);
  assert.equal(receipt.executed, false);
  assert.equal(receipt.status, 'denied');
});
