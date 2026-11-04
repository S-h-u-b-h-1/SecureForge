import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpServer } from '../src/mcp-server.mjs';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'secureforge-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.py'), 'def verify():\n    return True\n');
  const instance = await createMcpServer({ root, port: 0 });
  t.after(async () => { await new Promise((resolve) => instance.server.close(resolve)); await instance.workspace.close(); });
  const url = `http://127.0.0.1:${instance.address.port}/mcp`;
  const post = async (message, headers = {}) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(message) });
    return { status: res.status, data: res.status === 202 ? null : await res.json() };
  };
  const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
  return { root, post, request };
}

test('MCP initializes, advertises bounded tools, and handles notifications', async (t) => {
  const { post, request } = await setup(t);
  const init = await post(request(1, 'initialize', { protocolVersion: '2025-06-18' }));
  assert.equal(init.status, 200);
  assert.equal(init.data.result.protocolVersion, '2025-06-18');
  const tools = await post(request(2, 'tools/list'));
  assert.ok(tools.data.result.tools.some((x) => x.name === 'propose_edit'));
  assert.equal(tools.data.result.tools.some((x) => x.name === 'run_command'), false);
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
});

test('MCP tool calls return source evidence and unapplied proposal only', async (t) => {
  const { root, post, request } = await setup(t);
  const read = await post(request(3, 'tools/call', { name: 'read_file', arguments: { path: 'a.py' } }));
  const evidence = JSON.parse(read.data.result.content[0].text);
  const proposalCall = await post(request(4, 'tools/call', { name: 'propose_edit', arguments: { path: 'a.py', expectedSha256: evidence.sha256, proposedContent: 'def verify():\n    return False\n' } }));
  const proposal = JSON.parse(proposalCall.data.result.content[0].text);
  assert.equal(proposal.path, 'a.py');
  assert.equal(await readFile(path.join(root, 'a.py'), 'utf8'), 'def verify():\n    return True\n');
  const result = await post(request(5, 'tools/call', { name: 'check_proposal', arguments: { id: proposal.id } }));
  assert.equal(JSON.parse(result.data.result.content[0].text).fresh, true);
});

test('MCP origin restrictions and unsafe paths are enforced', async (t) => {
  const { post, request } = await setup(t);
  const refused = await post(request(1, 'tools/list'), { Origin: 'https://evil.example' });
  assert.equal(refused.status, 403);
  const result = await post(request(2, 'tools/call', { name: 'read_file', arguments: { path: '../secret' } }));
  assert.equal(result.data.result.isError, true);
  assert.match(result.data.result.content[0].text, /Unsafe path/);
});

test('MCP preserves UTF-8 characters when a multibyte code point spans HTTP chunks', async (t) => {
  const { root, request } = await setup(t);
  const { createMcpServer } = await import('../src/mcp-server.mjs');
  const http = await import('node:http');
  await writeFile(path.join(root, 'unicode.py'), '# café is a valid search term\n');
  // A separate instance is used for a deterministic, raw chunked HTTP client.
  const instance = await createMcpServer({ root, port: 0 });
  t.after(async () => { await new Promise((resolve) => instance.server.close(resolve)); await instance.workspace.close(); });
  const body = Buffer.from(JSON.stringify(request(9, 'tools/call', { name: 'search_workspace', arguments: { query: 'café' } })));
  const accentStart = body.indexOf(Buffer.from('é'));
  assert.ok(accentStart >= 0);
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: instance.address.port, path: '/mcp', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.write(body.subarray(0, accentStart + 1));
    setTimeout(() => req.end(body.subarray(accentStart + 1)), 12);
  });
  const value = JSON.parse(res.result.content[0].text);
  assert.equal(value.query, 'café');
  assert.ok(value.matches.some((m) => m.path === 'unicode.py'));
});


test('repository discovery is available through bounded read-only MCP calls', async t => {
  const { root, post, request } = await setup(t);
  const before = await readFile(path.join(root, 'a.py'), 'utf8');
  const response = await post(request(50, 'tools/call', { name: 'discover_repository', arguments: { task: 'verify function' } }));
  assert.equal(response.data.result.isError, undefined);
  const result = JSON.parse(response.data.result.content[0].text);
  assert.ok(result.candidates.some(item => item.path === 'a.py'));
  assert.equal(await readFile(path.join(root, 'a.py'), 'utf8'), before);
  const invalid = await post(request(51, 'tools/call', { name: 'discover_repository', arguments: { task: 'x'.repeat(401) } }));
  assert.equal(invalid.data.result.isError, true);
});

test('cancelled MCP capabilities reject new calls and suppress in-flight source results', { timeout: 5000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'secureforge-revocation-'));
  const controller = new AbortController();
  const instance = await createMcpServer({ root, port: 0, signal: controller.signal });
  t.after(async () => {
    instance.server.closeAllConnections();
    await new Promise(resolve => instance.server.close(resolve));
    await instance.workspace.close();
    await rm(root, { recursive: true, force: true });
  });
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const pendingRead = new Promise(resolve => { release = resolve; });
  instance.workspace.readFile = async () => {
    entered();
    await pendingRead;
    return { lines: [{ text: 'private dummy source' }] };
  };
  const url = `http://127.0.0.1:${instance.address.port}/mcp`;
  const call = () => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'dummy.py' } } }),
  });
  const inFlight = call();
  await started;
  controller.abort();
  release();
  const response = await inFlight;
  assert.equal(response.status, 410);
  assert.ok(!(await response.text()).includes('private dummy source'));
  assert.equal((await call()).status, 410);
});
