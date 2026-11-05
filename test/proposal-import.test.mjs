import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readProposalFile } from '../extension/review-ui.mjs';

test('proposal import preserves bounded UTF-8 data and rejects oversized or non-regular inputs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'proposal.json');
  const content = JSON.stringify({ rationale: 'Unicode café' });
  await writeFile(filename, content);
  assert.equal(await readProposalFile(filename), content);
  await assert.rejects(readProposalFile(root), /regular file/);
  await writeFile(filename, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
  await assert.rejects(readProposalFile(filename), /4 MiB/);
});

test('proposal import rejects a symlink instead of reopening its destination', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-import-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'proposal.json');
  await writeFile(filename, '{}');
  const link = path.join(root, 'linked.json');
  await symlink(filename, link);
  await assert.rejects(readProposalFile(link));
});
