import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForEditorReport } from './editor/report-wait.mjs';

test('editor launcher waits for final report after CLI returns exit 0', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-editor-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = path.join(root, 'report.json');
  const checkpoints = [];
  const writer = (async () => {
    await delay(15);
    await writeFile(report, JSON.stringify({ passed: ['one'], lastCheckpoint: 'one', incomplete: true }));
    await delay(25);
    await writeFile(report, JSON.stringify({ passed: ['one', 'two'] }));
  })();
  const result = await waitForEditorReport(report, {
    timeoutMs: 1000, pollMs: 5,
    onCheckpoint: value => checkpoints.push(value),
    getLaunchState: () => ({ exited: true, code: 0 }),
  });
  await writer;
  assert.deepEqual(result.passed, ['one', 'two']);
  assert.deepEqual(checkpoints, ['one']);
});

test('editor launcher retains an explicit failed test-host report', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-editor-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = path.join(root, 'report.json');
  await writeFile(report, JSON.stringify({ passed: ['one'], error: 'test assertion failed' }));
  const result = await waitForEditorReport(report, { timeoutMs: 100, pollMs: 5 });
  assert.equal(result.error, 'test assertion failed');
});

test('partial report does not certify success and timeout includes last checkpoint', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-editor-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = path.join(root, 'report.json');
  await writeFile(report, JSON.stringify({ passed: ['first'], incomplete: true, lastCheckpoint: 'first' }));
  await assert.rejects(waitForEditorReport(report, { timeoutMs: 45, pollMs: 5 }), /Last checkpoint: first/);
});

test('partially written JSON is retried instead of treated as a final failure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-editor-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = path.join(root, 'report.json');
  await writeFile(report, '{"passed":');
  const writer = (async () => {
    await delay(15);
    await writeFile(report, JSON.stringify({ passed: ['done'] }));
  })();
  const result = await waitForEditorReport(report, { timeoutMs: 500, pollMs: 5 });
  await writer;
  assert.deepEqual(result.passed, ['done']);
});

test('explicit CLI failure without report is not reported as success', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-editor-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(waitForEditorReport(path.join(root, 'missing.json'), {
    timeoutMs: 200, pollMs: 5, getLaunchState: () => ({ exited: true, code: 3 }),
  }), /exited with code 3/);
});
