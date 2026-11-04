import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from '../src/workspace.mjs';
import { ProposalStore } from '../src/proposals.mjs';
import { BatchProposalStore } from '../src/build/batches.mjs';
import { createMcpServer } from '../src/mcp-server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'secureforge-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  const content = new Map([
    ['src/a.py', 'def a():\n    return 1\n'],
    ['src/b.py', 'def b():\n    return 2\n'],
    ['src/c.py', 'def c():\n    return 3\n'],
  ]);
  for (const [file, text] of content) await writeFile(path.join(root, file), text);
  const workspace = await new Workspace(root).init();
  t.after(() => workspace.close?.());
  const proposals = new ProposalStore(workspace);
  const batches = new BatchProposalStore(proposals);
  const edits = [];
  for (const [file, text] of content) {
    const read = await workspace.readFile(file);
    edits.push({ path: file, expectedSha256: read.sha256, proposedContent: text.replace(/return \d/, 'return 42'), rationale: 'coordinated test' });
  }
  return { root, content, proposals, batches, workspace, edits };
}

test('3-file batch reuses ProposalStore v1 IDs and never modifies source files', async (t) => {
  const { root, content, proposals, batches, edits } = await fixture(t);
  const batch = await batches.proposeBatch({ edits, rationale: 'three files' });
  assert.equal(batch.schemaVersion, 1);
  assert.equal(batch.status, 'pending');
  assert.equal(batch.fileCount, 3);
  assert.equal(new Set(batch.proposals.map((p) => p.id)).size, 3);
  for (const p of batch.proposals) {
    assert.equal(proposals.getProposal(p.id).path, p.path);
    assert.equal(proposals.getProposal(p.id).baseSha256, p.baseSha256);
    assert.equal(await readFile(path.join(root, p.path), 'utf8'), content.get(p.path));
  }
  assert.equal((await batches.checkBatch(batch.id)).fresh, true);
  assert.deepEqual(batches.getBatch(batch.id), batch);
});

test('stale edit during creation rolls back previously staged proposals', async (t) => {
  const { root, proposals, batches, edits } = await fixture(t);
  await writeFile(path.join(root, 'src/c.py'), 'changed by user\n');
  await assert.rejects(batches.proposeBatch({ edits }), /Stale base/);
  // Deterministic IDs cannot be predicted, but no batch can be retrieved and
  // the proposal capacity is not consumed by the failed transaction.
  const read = await readFile(path.join(root, 'src/c.py'), 'utf8');
  assert.equal(read, 'changed by user\n');
  const retry = [ ...edits.slice(0, 2) ];
  const two = await batches.proposeBatch({ edits: retry });
  assert.equal(two.fileCount, 2);
  for (const p of two.proposals) assert.equal(proposals.getProposal(p.id).status, 'pending');
});

test('failed later edit leaves no orphaned proposals or reserved capacity', async (t) => {
  const { workspace, edits } = await fixture(t);
  const proposals = new ProposalStore(workspace, { limit: 3 });
  const batches = new BatchProposalStore(proposals);
  const invalid = edits.map((edit) => ({ ...edit }));
  invalid[2].expectedSha256 = 'f'.repeat(64);
  await assert.rejects(batches.proposeBatch({ edits: invalid }), /Stale base/);
  // All three slots must still be available after the failed attempt.
  const retry = await batches.proposeBatch({ edits });
  assert.equal(retry.fileCount, 3);
});

test('checkBatch fails closed when any file changes or an individual proposal disappears', async (t) => {
  const { root, proposals, batches, edits } = await fixture(t);
  const batch = await batches.proposeBatch({ edits });
  await writeFile(path.join(root, 'src/b.py'), 'human change\n');
  let status = await batches.checkBatch(batch.id);
  assert.equal(status.fresh, false);
  assert.equal(status.results.find((x) => x.path === 'src/b.py').fresh, false);
  assert.equal(status.results.filter((x) => x.fresh).length, 2);
  proposals.discard(batch.proposals[0].id);
  status = await batches.checkBatch(batch.id);
  assert.equal(status.fresh, false);
  assert.equal(status.results.find((x) => x.id === batch.proposals[0].id).fresh, false);
  assert.equal(batches.discardBatch(batch.id).discarded, true);
  assert.throws(() => batches.getBatch(batch.id), /not found/);
});

test('reject duplicate paths, invalid hashes, oversized batches, empty batches and credentials', async (t) => {
  const { root, batches, workspace, edits } = await fixture(t);
  await assert.rejects(batches.proposeBatch({ edits: [edits[0], edits[0]] }), /Duplicate/);
  await assert.rejects(batches.proposeBatch({ edits: [{ ...edits[0], path: 'SRC\\A.py' }, edits[0]] }), /Duplicate/);
  await assert.rejects(batches.proposeBatch({ edits: [] }), /2\.\.8/);
  await assert.rejects(batches.proposeBatch({ edits: [ { ...edits[0], expectedSha256: 'bad' }, edits[1] ] }), /expectedSha256/);
  await assert.rejects(batches.proposeBatch({ edits: [ { ...edits[0], proposedContent: 'x'.repeat(256 * 1024) }, edits[1] ] }), /exceeds/);
  await writeFile(path.join(root, 'src/config.py'), 'password = secretvalue\n');
  const secret = await workspace.readFile('src/config.py');
  await assert.rejects(batches.proposeBatch({ edits: [edits[0], { path: 'src/config.py', expectedSha256: secret.sha256, proposedContent: '{}' }] }), /redacted credentials/);
});

test('MCP exposes in-memory batch tools and leaves disk unchanged', async (t) => {
  const { root, content, edits } = await fixture(t);
  const instance = await createMcpServer({ root, port: 0 });
  t.after(() => new Promise((resolve) => instance.server.close(resolve)));
  const url = 'http://127.0.0.1:' + instance.address.port + '/mcp';
  let id = 1;
  async function call(method, params = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
    });
    assert.equal(res.status, 200);
    return (await res.json()).result;
  }
  const tools = await call('tools/list');
  for (const tool of ['propose_batch', 'get_batch', 'check_batch']) assert.ok(tools.tools.some((x) => x.name === tool));
  const result = await call('tools/call', { name: 'propose_batch', arguments: { edits, rationale: 'MCP test' } });
  assert.equal(result.isError, undefined);
  const batch = JSON.parse(result.content[0].text);
  assert.equal(batch.fileCount, 3);
  const get = await call('tools/call', { name: 'get_batch', arguments: { id: batch.id } });
  assert.equal(JSON.parse(get.content[0].text).proposals.length, 3);
  const check = await call('tools/call', { name: 'check_batch', arguments: { id: batch.id } });
  assert.equal(JSON.parse(check.content[0].text).fresh, true);
  const one = await call('tools/call', { name: 'get_proposal', arguments: { id: batch.proposals[0].id } });
  assert.equal(JSON.parse(one.content[0].text).path, batch.proposals[0].path);
  for (const [file, text] of content) assert.equal(await readFile(path.join(root, file), 'utf8'), text);
});
