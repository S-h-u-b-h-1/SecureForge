import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiveRun, localTrueForgeUrl } from '../src/live-run.mjs';
import { sha256 } from '../src/workspace.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-live-'));
  await writeFile(path.join(root, 'sample.py'), 'old\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function clientFor(runTools, terminalState = { status: 'done' }, visibleReply = '', progressText = '') {
  let manifest;
  const counters = { turns: 0, cancellations: 0, deletions: 0 };
  const client = {
    settings: { mcpServers: {
      create: async input => { manifest = input.manifest; },
      delete: async () => { counters.deletions++; },
    } },
    sessions: {
      create: async () => ({ data: { id: 'session-test' } }),
      cancel: async () => { counters.cancellations++; },
      createTurnStream: async (_id, _request, options) => ({
        async *withMetadata() {
          counters.turns++;
          await runTools(manifest, options);
          if (progressText) yield { data: { type: 'model.message.delta', content: progressText } };
          yield { data: { type: 'tool.response', content: 'tool output must never appear in answer' } };
          if (visibleReply) yield { data: { type: 'model.message.delta', content: visibleReply } };
          yield { data: { type: 'turn.done', state: terminalState } };
        },
      }),
    },
  };
  return { client, counters };
}

test('live workflow receives a real MCP-staged proposal without disk writes', async t => {
  const root = await fixture(t);
  const { client, counters } = clientFor(async manifest => {
    const unauth = await fetch(manifest.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauth.status, 401);
    const result = await fetch(manifest.url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...manifest.auth.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'propose_edit', arguments: { path: 'sample.py', expectedSha256: sha256('old\n'), proposedContent: 'new\n' },
      } }),
    });
    assert.ok((await result.json()).result.content);
  });
  const run = new LiveRun({ client, root });
  const result = await run.run({ model: 'test/model', task: 'Change the sample' });
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].proposedContent, 'new\n');
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'old\n');
  assert.equal(counters.deletions, 1);
  await assert.rejects(run.run({ model: 'test/model', task: 'replay' }), /replayed/);
});

test('cancelled live runs discard proposals and do not replay a turn', async t => {
  const root = await fixture(t);
  let run;
  const { client, counters } = clientFor(async () => { await run.cancel(); });
  run = new LiveRun({ client, root });
  await assert.rejects(run.run({ model: 'test/model', task: 'cancel' }), /cancelled/);
  assert.equal(run.state, 'cancelled');
  assert.deepEqual(run.staged, []);
  assert.equal(counters.turns, 1);
  assert.ok(counters.cancellations > 0);
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'old\n');
});

test('model failures preserve files and local URL validation blocks remote origins', async t => {
  const root = await fixture(t);
  const { client, counters } = clientFor(async () => { throw new Error('private provider details'); });
  const run = new LiveRun({ client, root });
  await assert.rejects(run.run({ model: 'test/model', task: 'fail' }), error => {
    assert.ok(!error.message.includes('private provider details'));
    return /failed/.test(error.message);
  });
  assert.equal(counters.turns, 1);
  assert.equal(counters.deletions, 1);
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'old\n');
  for (const url of ['https://example.com', 'http://localhost@external.test', 'http://localhost:8790/path']) {
    assert.throws(() => localTrueForgeUrl(url));
  }
});

test('credential-bearing task mentions and inline paths never reach TrueForge', async t => {
  const root = await fixture(t);
  const token = 'ghp_abcdefghijklmnopqrstuv';
  let contacted = false;
  const client = new Proxy({}, { get() { contacted = true; throw new Error('Unexpected API access'); } });
  for (const request of [
    { task: `Fix login @file:src/login-${token}.js` },
    { task: 'Fix login', selection: { path: `src/login-${token}.js` } },
  ]) {
    const run = new LiveRun({ client, root });
    await assert.rejects(run.run({ model: 'test/model', ...request }), /recognized credential patterns/);
    assert.equal(run.state, 'idle');
  }
  assert.equal(contacted, false);
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'old\n');
});

test('iteration exhaustion retains terminal status and session without exposing raw provider text', async t => {
  const root = await fixture(t);
  const { client } = clientFor(async () => {}, { status: 'error', message: 'You have reached iteration limit of 30 private-provider-detail' });
  const run = new LiveRun({ client, root });
  await assert.rejects(run.run({ model: 'test/model', task: 'Make a bounded edit' }), error => {
    assert.equal(error.code, 'iteration_limit');
    assert.match(error.message, /iteration limit 30/);
    assert.match(error.message, /session-test/);
    assert.ok(!error.message.includes('private-provider-detail'));
    assert.equal(error.diagnostics.terminalStatus, 'error');
    assert.equal(error.diagnostics.sessionId, 'session-test');
    return true;
  });
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'old\n');
});

test('unknown failure codes cannot select prototype properties in diagnostics', async t => {
  const root = await fixture(t);
  const { client } = clientFor(async () => { throw Object.assign(new Error('private provider data'), { code: 'constructor' }); });
  const run = new LiveRun({ client, root });
  await assert.rejects(run.run({ model: 'test/model', task: 'Inspect source' }), error => {
    assert.equal(error.code, 'runtime_or_model_error');
    assert.ok(!error.message.includes('private provider data'));
    assert.equal(error.diagnostics.sessionId, 'session-test');
    return true;
  });
});

test('completed runs return only bounded, redacted user-visible model replies', async t => {
  const root = await fixture(t);
  const { client } = clientFor(async () => {}, { status: 'done' },
    'Could not stage a patch; found missing context. password=hidden-value-for-test');
  const run = new LiveRun({ client, root });
  const result = await run.run({ model: 'test/model', task: 'Inspect without editing' });
  assert.equal(result.proposals.length, 0);
  assert.match(result.reply, /Could not stage a patch/);
  assert.doesNotMatch(result.reply, /hidden-value-for-test|tool output must never/);
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'old\n');
});

test('model answer shown in the sidebar is bounded', async t => {
  const root = await fixture(t);
  const { client } = clientFor(async () => {}, { status: 'done' }, 'A'.repeat(12000));
  const run = new LiveRun({ client, root });
  const result = await run.run({ model: 'test/model', task: 'Explain the code' });
  assert.ok(result.reply.length <= 3000);
  assert.ok(result.reply.startsWith('A'));
});

test('sidebar reply contains the final answer without prior search narration', async t => {
  const root = await fixture(t);
  const { client } = clientFor(async () => {}, { status: 'done' },
    'There are no matching Flask files in this project.',
    'I am checking the repository... Searching for Flask... ');
  const run = new LiveRun({ client, root });
  const result = await run.run({ model: 'test/model', task: 'Inspect project' });
  assert.equal(result.reply, 'There are no matching Flask files in this project.');
  assert.doesNotMatch(result.reply, /Searching for Flask/);
});

test('a follow-up starts a fresh TrueForge session with bounded prior conversation context', async t => {
  const root = await fixture(t);
  const inputs = [];
  const client = {
    settings: { mcpServers: { create: async () => {}, delete: async () => {} } },
    sessions: {
      create: async () => ({ data: { id: 'followup-session' } }),
      createTurnStream: async (_id, payload) => {
        inputs.push(payload.input);
        return { withMetadata: async function* () {
          yield { data: { type: 'turn.done', state: { status: 'done' } } };
        } };
      },
    },
  };
  const run = new LiveRun({ client, root });
  const result = await run.run({
    model: 'provider/test-model', task: 'Now add a related test',
    conversation: [{ user: 'Fix the parser', assistant: 'A proposed change was staged.',
      outcome: 'proposal_staged' }],
  });
  assert.equal(result.sessionId, 'followup-session');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0][0].content, 'Now add a related test');
  assert.match(inputs[0][1].content, /Fix the parser/);
  assert.match(inputs[0][1].content, /untrusted/);
  assert.match(inputs[0][1].content, /proposal_staged/);
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'old\n');
});

test('authentication failures produce actionable redacted errors without applying proposals', async t => {
  const root = await fixture(t);
  const { client } = clientFor(async () => {
    throw Object.assign(new Error('Provider returned SECRET=my-private-api-key'), { status: 401 });
  });
  const run = new LiveRun({ client, root });
  await assert.rejects(run.run({ model: 'provider/expired', task: 'Inspect repository' }), error => {
    assert.equal(error.code, 'authentication');
    assert.match(error.message, /TrueForge Settings/);
    assert.doesNotMatch(error.message, /my-private-api-key/);
    return true;
  });
  assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), 'old\n');
});
