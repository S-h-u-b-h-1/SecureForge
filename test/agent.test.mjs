import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentSpec, runAgentTurn } from '../src/agent.mjs';

test('agent spec uses TrueForge runtime with only explicitly allowed workspace tools', () => {
  const spec = buildAgentSpec({ model: 'configured-provider/test-model', mcpServerName: 'secureforge-workspace' });
  assert.equal(spec.model.name, 'configured-provider/test-model');
  assert.deepEqual(spec.mcp_servers[0].require_approval_for_tools, ['propose_edit', 'propose_batch']);
  assert.equal(spec.mcp_servers[0].enable_tools.includes('run_command'), false);
  assert.equal(spec.mcp_servers[0].enable_tools.includes('discover_repository'), true);
  assert.equal(spec.mcp_servers[0].enable_tools.includes('read_source_bundle'), true);
  assert.equal(spec.config.iteration_limit, 30);
  assert.equal(spec.mcp_servers[0].enable_tools.includes('propose_batch'), true);
  assert.equal(spec.mcp_servers[0].enable_tools.includes('apply_patch'), false);
  assert.equal(spec.instructions.includes('untrusted data'), true);
});

test('TrueForge event streaming is passed through without provider access', async () => {
  const seen = [];
  const client = {
    sessions: {
      async create({ agent }) { assert.equal(agent.spec.model.name, 'test/a'); return { data: { id: 'sess-1' } }; },
      async createTurnStream(id, payload) {
        assert.equal(id, 'sess-1');
        assert.equal(payload.input[0].content, 'Inspect code');
        return { withMetadata: async function* () {
          yield { data: { type: 'model.message.delta', content: 'hello' } };
          yield { data: { type: 'turn.done', state: { status: 'done' } } };
        } };
      },
    },
  };
  const result = await runAgentTurn({ client, model: 'test/a', task: 'Inspect code', onEvent: (e) => seen.push(e.type) });
  assert.equal(result.sessionId, 'sess-1');
  assert.equal(result.state.status, 'done');
  assert.deepEqual(seen, ['model.message.delta', 'turn.done']);
});

test('unexpected incomplete turn is not mistaken for success', async () => {
  const client = { sessions: { create: async () => ({ data: { id: 's' } }), createTurnStream: async () => ({ withMetadata: async function* () { yield { data: { type: 'model.message.delta' } }; } }) } };
  await assert.rejects(runAgentTurn({ client, model: 'test/b', task: 'Work' }), /without turn.done/);
});
