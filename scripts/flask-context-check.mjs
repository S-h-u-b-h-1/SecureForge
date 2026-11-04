import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Workspace, sha256 } from '../src/workspace.mjs';
import { assembleContext } from '../src/context.mjs';
import { createTrueForgeClient } from '../src/agent.mjs';
import { LiveRun } from '../src/live-run.mjs';
import { discoverRelevantFiles } from '../src/build/repository-discovery.mjs';

const checkout = path.resolve(process.argv[2] || '.tmp/flask-3.1.3');
const output = path.resolve('outputs/flask-rehearsal/context-and-failure.json');
const report = JSON.parse(await readFile('outputs/flask-rehearsal/flask-rehearsal.json', 'utf8'));
const workspace = await new Workspace(checkout).init();
const execute = promisify(execFile);
const status = async () => (await execute('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: checkout })).stdout;
try {
  const discovery = await discoverRelevantFiles({ workspace, task: report.taskB.instruction });
  for (const expected of ['src/flask/cli.py', 'docs/cli.rst']) {
    assert.ok(discovery.candidates.some(source => source.path === expected));
  }
  const context = await assembleContext(workspace, report.taskB.instruction);
  for (const expected of ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst']) {
    assert.ok(context.sources.some(source => source.path === expected), `Missing task B context ${expected}`);
  }
  const files = ['src/flask/helpers.py', 'src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst'];
  const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, sha256(await readFile(path.join(checkout, file)))])));
  const before = { gitStatus: await status(), hashes: await hashes() };
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const client = await createTrueForgeClient({ baseUrl: `http://127.0.0.1:${port}` });
  const run = new LiveRun({ client, root: checkout });
  const started = Date.now();
  let failure;
  try { await run.run({ model: 'unavailable-model', task: report.taskA.instruction }); }
  catch (error) { failure = error.message; }
  assert.match(failure ?? '', /TrueForge run failed/);
  assert.equal(run.state, 'error');
  const after = { gitStatus: await status(), hashes: await hashes() };
  assert.deepEqual(after, before);
  const result = {
    mode: 'model-independent context and real SDK unreachable-endpoint checks',
    discovery: { ...discovery, note: 'Post-reference discovery skips files with masked credential patterns, including the appended synthetic credential test. Extension context still includes redacted test excerpts.' },
    taskB: { sources: context.sources.map(({ content, ...source }) => source), usedBytes: context.usedBytes, budgetBytes: context.budgetBytes },
    taskC: { status: 'passed_local_failure_check', failure, elapsedMs: Date.now() - started, unchanged: true, before, after,
      limitation: 'Editor responsiveness and the official recording remain pending.' },
  };
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ contextFiles: result.taskB.sources.map(source => source.path), taskC: result.taskC.status, output }));
} finally { await workspace.close(); }
