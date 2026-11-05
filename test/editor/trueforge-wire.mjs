// Explicit integration fixture: real TrueForge runtime and SDK, deterministic
// local OpenAI-compatible inference responses. This is not a real-model demo.
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createTrueForgeClient } from '../../src/agent.mjs';
import { LiveRun } from '../../src/live-run.mjs';
import { sha256 } from '../../src/workspace.mjs';

export async function verifyTrueForgeWire({ onPayload = async () => {}, onConfigured = async () => {}, compactBatch = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-wire-'));
  const original = 'first\nkeep\nlast\n';
  await writeFile(path.join(root, 'sample.py'), original);
  // Exceed TrueForge's default 24,000-character response threshold while
  // remaining well inside SecureForge's 96 KiB source-bundle policy.
  const largeSource = '# bounded source evidence\n'.repeat(1200) + '# COMPLETE_SOURCE_END\n';
  await writeFile(path.join(root, 'large.py'), largeSource);
  const provider = `sf-wire-${randomUUID().slice(0, 8)}`;
  let requests = 0;
  let completeBundleReceived = false;
  let advertisedTools = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests++;
    if (requests === 1) advertisedTools = (body.tools ?? []).map(item => item.function?.name ?? '');
    const toolName = name => body.tools?.find(item => item.function?.name.endsWith(name))?.function.name ?? name;
    let tool;
    if (requests === 1) {
      tool = { name: toolName('read_source_bundle'), arguments: JSON.stringify({ paths: ['sample.py', 'large.py'] }) };
    } else if (requests === 2) {
      const responses = body.messages.filter(message => message.role === 'tool').map(message => message.content);
      completeBundleReceived = responses.some(content => {
        try { return JSON.parse(content).files?.some(file => file.path === 'large.py' && file.content === largeSource); }
        catch { return false; }
      });
      tool = compactBatch ? { name: toolName('propose_patch_batch'), arguments: JSON.stringify({ edits: [
        { path: 'sample.py', expectedSha256: sha256(original), replacements: [{ oldText: original, newText: 'FIRST\nkeep\nLAST\n' }] },
        { path: 'large.py', expectedSha256: sha256(largeSource), replacements: [{ oldText: '# COMPLETE_SOURCE_END', newText: '# COMPLETE_SOURCE_REVIEWED' }] },
      ], rationale: 'Deterministic compact transport fixture' }) } : { name: toolName('propose_edit'), arguments: JSON.stringify({
        path: 'sample.py', expectedSha256: sha256(original), proposedContent: 'FIRST\nkeep\nLAST\n', rationale: 'Deterministic wire fixture',
      }) };
    }
    const message = tool
      ? { role: 'assistant', content: null, tool_calls: [{ id: `wire-call-${requests}`, type: 'function', function: tool }] }
      : { role: 'assistant', content: 'The deterministic fixture proposal is staged for human review.' };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = tool
        ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] }
        : message;
      res.write(`data: ${JSON.stringify({ id: 'wire', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'wire', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'wire', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = await createTrueForgeClient();
  let registered = false;
  try {
    await client.settings.modelProviders.create({ manifest: {
      type: 'custom', name: provider, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      auth: { apiKey: 'local-fixture-only' },
      models: [{ name: 'fixture', modelId: 'fixture', properties: { contextLength: 32000, maxOutputTokens: 2000 } }],
    } });
    registered = true;
    const events = [];
    const run = new LiveRun({ client, root, approveTool: async () => true, onEvent: event => events.push(event.type) });
    const payload = await run.run({ model: `${provider}/fixture`, task: 'Run the deterministic proposal handoff fixture' });
    assert.ok(completeBundleReceived, 'The model must receive the complete bounded bundle, not a runtime size-limit message');
    for (const forbidden of ['create_sub_agent', 'run_command', 'web_search']) {
      assert.equal(advertisedTools.some(name => name.endsWith(forbidden)), false, `${forbidden} must not be available`);
    }
    assert.equal(payload.proposals.length, compactBatch ? 2 : 1);
    assert.equal(payload.diagnostics.toolCounts.read_source_bundle, 1);
    assert.ok(payload.diagnostics.sources.some(source => source.path === 'sample.py' && source.sha256 === sha256(original)));
    assert.equal(payload.diagnostics.terminalStatus, 'done');
    assert.equal(payload.proposals[0].proposedContent, 'FIRST\nkeep\nLAST\n');
    assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), original);
    assert.equal(await readFile(path.join(root, 'large.py'), 'utf8'), largeSource);
    if (compactBatch) assert.equal(payload.diagnostics.toolCounts.propose_patch_batch, 1);
    assert.ok(events.includes('tool.approval_required'));
    await onPayload(payload, root);
    requests = 0;
    await onConfigured({ root, model: `${provider}/fixture` });
    return { sessionId: payload.sessionId, provider: 'deterministic local fixture', compactBatch, completeBundleReceived,
      events, proposals: payload.proposals.length, diagnostics: payload.diagnostics };
  } finally {
    if (registered) await client.settings.modelProviders.delete(provider);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await verifyTrueForgeWire(), null, 2));
  console.log(JSON.stringify(await verifyTrueForgeWire({ compactBatch: true }), null, 2));
}
