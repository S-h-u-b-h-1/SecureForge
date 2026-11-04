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

export async function verifyTrueForgeWire({ onPayload = async () => {}, onConfigured = async () => {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-wire-'));
  const original = 'first\nkeep\nlast\n';
  await writeFile(path.join(root, 'sample.py'), original);
  const provider = `sf-wire-${randomUUID().slice(0, 8)}`;
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests++;
    const connector = JSON.stringify(body).match(/secureforge-[0-9a-f]{8}/)?.[0];
    let tool;
    if (requests === 1) {
      tool = { name: 'list_tools', arguments: JSON.stringify({ mcp_server: connector }) };
    } else if (requests === 2) {
      tool = { name: 'get_tool_info', arguments: JSON.stringify({ mcp_server: connector, tool_name: 'read_file' }) };
    } else if (requests === 3) {
      tool = { name: 'call_tool', arguments: JSON.stringify({ mcp_server: connector, tool_name: 'read_file', input: { path: 'sample.py' } }) };
    } else if (requests === 4) {
      tool = { name: 'get_tool_info', arguments: JSON.stringify({ mcp_server: connector, tool_name: 'propose_edit' }) };
    } else if (requests === 5) {
      tool = { name: 'call_tool', arguments: JSON.stringify({ mcp_server: connector, tool_name: 'propose_edit', input: {
        path: 'sample.py', expectedSha256: sha256(original), proposedContent: 'FIRST\nkeep\nLAST\n', rationale: 'Deterministic wire fixture',
      } }) };
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
    assert.equal(payload.proposals.length, 1);
    assert.equal(payload.proposals[0].proposedContent, 'FIRST\nkeep\nLAST\n');
    assert.equal(await readFile(path.join(root, 'sample.py'), 'utf8'), original);
    assert.ok(events.includes('tool.approval_required'));
    await onPayload(payload, root);
    requests = 0;
    await onConfigured({ root, model: `${provider}/fixture` });
    return { sessionId: payload.sessionId, provider: 'deterministic local fixture', events, proposals: payload.proposals.length };
  } finally {
    if (registered) await client.settings.modelProviders.delete(provider);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await verifyTrueForgeWire(), null, 2));
}
