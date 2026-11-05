import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace, sha256 } from '../src/workspace.mjs';
import { ProposalStore } from '../src/proposals.mjs';
import { BatchProposalStore } from '../src/build/batches.mjs';
import { proposePatchBatch } from '../src/build/patch-batch.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-patch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originals = ['😀 café\r\nfirst\r\nkeep\r\nlast', 'alpha\nbeta\n'];
  await Promise.all(originals.map((text, index) => writeFile(path.join(root, `${index}.py`), text)));
  const workspace = await new Workspace(root).init();
  t.after(() => workspace.close());
  const proposals = new ProposalStore(workspace);
  const batches = new BatchProposalStore(proposals);
  const edits = [
    { path: '0.py', expectedSha256: sha256(originals[0]), replacements: [
      { oldText: 'first', newText: 'FIRST' }, { oldText: 'last', newText: 'LAST' },
    ] },
    { path: '1.py', expectedSha256: sha256(originals[1]), replacements: [{ oldText: 'beta', newText: 'BETA' }] },
  ];
  return { root, originals, workspace, proposals, batches, edits };
}

test('compact replacements preserve UTF-8, CRLF and missing newline in unapplied full v1 proposals', async t => {
  const f = await fixture(t);
  const batch = await proposePatchBatch({ ...f, rationale: 'Coordinated compact review' });
  assert.equal(batch.fileCount, 2);
  const first = f.proposals.getProposal(batch.proposals[0].id);
  assert.equal(first.originalContent, f.originals[0]);
  assert.equal(first.proposedContent, '😀 café\r\nFIRST\r\nkeep\r\nLAST');
  assert.equal(first.proposedSha256, sha256(first.proposedContent));
  assert.equal((await f.batches.checkBatch(batch.id)).fresh, true);
  for (let index = 0; index < 2; index++) assert.equal(await readFile(path.join(f.root, `${index}.py`), 'utf8'), f.originals[index]);
});

test('invalid, absent, ambiguous, overlapping and duplicate replacements fail before any staging', async t => {
  const f = await fixture(t);
  for (const mutate of [
    edits => { edits[1].replacements[0].oldText = ''; },
    edits => { edits[1].replacements[0].oldText = 'missing'; },
    edits => { edits[1].replacements[0].oldText = 'a'; },
    edits => { edits[1].replacements.push({ oldText: 'eta', newText: 'ETA' }); },
    edits => { edits[1].path = '0.py'; },
    edits => { edits[1].expectedSha256 = '0'.repeat(64); },
    edits => { edits[1].path = './1.py'; },
    edits => { edits[1].path = '../outside.py'; },
    edits => { edits[1].replacements[0].newText = 'x'.repeat(65536); },
  ]) {
    const edits = structuredClone(f.edits); mutate(edits);
    let staged = false;
    await assert.rejects(proposePatchBatch({ ...f, edits, batches: { proposeBatch() { staged = true; } } }));
    assert.equal(staged, false);
  }
});

test('patch batches reject symlinks and recognized credential content', async t => {
  const f = await fixture(t);
  await symlink(path.join(f.root, '1.py'), path.join(f.root, 'linked.py'));
  await assert.rejects(proposePatchBatch({ ...f, edits: [f.edits[0], { ...f.edits[1], path: 'linked.py' }] }));
  const credential = 'api_key = "sk-' + 'a'.repeat(40) + '"\n';
  await writeFile(path.join(f.root, '1.py'), credential);
  await assert.rejects(proposePatchBatch({ ...f, edits: [f.edits[0], {
    path: '1.py', expectedSha256: sha256(credential), replacements: [{ oldText: credential, newText: 'removed\n' }],
  }] }), /Credential/);
  await writeFile(path.join(f.root, '1.py'), f.originals[1]);
  await assert.rejects(proposePatchBatch({ ...f, edits: [f.edits[0], {
    ...f.edits[1], replacements: [{ oldText: 'beta', newText: credential }],
  }] }), /Credential/);
});

test('cancellation after a source read publishes no batch', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let staged = false;
  const workspace = { async rawForProposal(file) {
    const source = await f.workspace.rawForProposal(file); controller.abort(); return source;
  } };
  await assert.rejects(proposePatchBatch({ ...f, workspace, signal: controller.signal,
    batches: { proposeBatch() { staged = true; } },
  }));
  assert.equal(staged, false);
});

test('source changes between expansion and full proposal staging are revalidated', async t => {
  const f = await fixture(t);
  await assert.rejects(proposePatchBatch({ ...f, batches: { async proposeBatch(request) {
    await writeFile(path.join(f.root, '1.py'), 'external change\n');
    return f.batches.proposeBatch(request);
  } } }), /Stale/);
  assert.equal(await readFile(path.join(f.root, '0.py'), 'utf8'), f.originals[0]);
  assert.equal(await readFile(path.join(f.root, '1.py'), 'utf8'), 'external change\n');
});

test('cancellation during batch staging discards the batch and its full proposals', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let created;
  await assert.rejects(proposePatchBatch({ ...f, signal: controller.signal, batches: {
    async proposeBatch(request) { created = await f.batches.proposeBatch(request); controller.abort(); return created; },
    discardBatch: id => f.batches.discardBatch(id),
  } }));
  assert.throws(() => f.batches.getBatch(created.id), /not found/);
  for (const proposal of created.proposals) assert.throws(() => f.proposals.getProposal(proposal.id), /not found/);
});
