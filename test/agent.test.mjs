import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentSpec, runAgentTurn, resolveTrueForgeModel } from '../src/agent.mjs';

test('agent spec uses TrueForge runtime with only explicitly allowed workspace tools', () => {
  const spec = buildAgentSpec({ model: 'configured-provider/test-model', mcpServerName: 'secureforge-workspace' });
  assert.equal(spec.model.name, 'configured-provider/test-model');
  assert.deepEqual(spec.mcp_servers[0].require_approval_for_tools, ['propose_edit', 'propose_batch', 'propose_patch_batch']);
  assert.equal(spec.mcp_servers[0].enable_tools.includes('run_command'), false);
  assert.equal(spec.mcp_servers[0].enable_tools.includes('discover_repository'), true);
  assert.equal(spec.mcp_servers[0].enable_tools.includes('read_source_bundle'), true);
  assert.equal(spec.config.iteration_limit, 30);
  assert.equal(spec.config.context_management.large_tool_response.enabled, false);
  assert.equal(spec.mcp_servers[0].preload, true);
  assert.equal(spec.config.dynamic_sub_agents.enabled, false);
  assert.equal(spec.config.sandbox.enabled, false);
  assert.equal(spec.config.web_search.enabled, false);
  assert.equal(spec.config.generative_ui.enabled, false);
  assert.equal(spec.config.ask_user_questions.enabled, false);
  assert.equal(spec.mcp_servers[0].enable_tools.includes('propose_batch'), true);
  assert.equal(spec.mcp_servers[0].enable_tools.includes('apply_patch'), false);
  assert.equal(spec.instructions.includes('untrusted data'), true);
  assert.match(spec.instructions, /run_command is available/);
  assert.match(spec.instructions, /"python3"/);
  assert.match(spec.instructions, /"tests\/test_helpers\.py"/);
  assert.match(spec.instructions, /verification DID NOT PASS/);
  assert.match(spec.instructions, /separately|user must approve the exact command/);
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

test('configured local model is reused without discovery or another prompt', async () => {
  const model = await resolveTrueForgeModel({
    configured: 'meta-muse/muse-spark-1-3', baseUrl: 'http://127.0.0.1:8790',
    fetchImpl: () => { throw new Error('Should not contact TrueForge'); },
    enterModel: () => { throw new Error('Should not prompt'); },
  });
  assert.equal(model, 'meta-muse/muse-spark-1-3');
});

test('a single model from the local TrueForge catalog is selected automatically', async () => {
  const model = await resolveTrueForgeModel({
    baseUrl: 'http://127.0.0.1:8790',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8790/api/v1/models');
      assert.equal(options.redirect, 'error');
      return { ok: true, json: async () => ({ data: [{ name: 'meta-muse/muse-spark-1-3' }] }) };
    },
    enterModel: () => { throw new Error('Unnecessary prompt'); },
  });
  assert.equal(model, 'meta-muse/muse-spark-1-3');
});

test('multiple models require selection and unavailable catalogs allow manual setup', async () => {
  const chosen = await resolveTrueForgeModel({
    baseUrl: 'http://127.0.0.1:8790',
    fetchImpl: async () => ({ ok: true, json: async () => ({
      data: [{ name: 'model/a' }, { name: 'model/b' }, { name: '../../invalid name' }],
    }) }),
    chooseModel: async choices => { assert.deepEqual(choices, ['model/a', 'model/b']); return 'model/b'; },
    enterModel: () => { throw new Error('User already chose'); },
  });
  assert.equal(chosen, 'model/b');
  const fallback = await resolveTrueForgeModel({
    baseUrl: 'http://127.0.0.1:8790',
    fetchImpl: async () => { throw new Error('Offline'); },
    enterModel: async () => 'manual/provider',
  });
  assert.equal(fallback, 'manual/provider');
});
