import test from 'node:test';
import assert from 'node:assert/strict';
import { registerWorkflows } from '../extension/workflows.mjs';

test('model selection refreshes the catalog and persists separately for each workspace', async () => {
  const commands = new Map();
  const storage = new Map();
  const workspaceFolders = [{
    name: 'workspace-a', uri: { scheme: 'file', fsPath: '/tmp/secureforge-workspace-a' },
  }];
  const notices = [];
  const vscode = {
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
    workspace: {
      isTrusted: true, workspaceFolders,
      getConfiguration: () => ({ get: (key, fallback) => ({
        model: '', trueforgeUrl: 'http://localhost:8790',
      })[key] ?? fallback }),
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, clear() {}, dispose() {} }),
      registerWebviewViewProvider: () => ({ dispose() {} }),
      showErrorMessage: message => notices.push(message),
    },
  };
  const context = {
    subscriptions: [],
    workspaceState: {
      get: key => storage.get(key),
      update: async (key, value) => { storage.set(key, value); },
    },
  };
  const fetched = [];
  const state = registerWorkflows(vscode, context, {
    modelCatalog: async ({ baseUrl }) => {
      fetched.push(baseUrl);
      return ['provider/model-a', 'provider/model-b'];
    },
  });
  const events = [];
  state.subscribe(value => events.push(value));
  const a = await state.refreshModels();
  assert.deepEqual(a.models, ['provider/model-a', 'provider/model-b']);
  assert.equal(a.selected, '');
  await state.selectModel('provider/model-a');
  assert.equal(events.at(-1).selected, 'provider/model-a');
  await assert.rejects(state.selectModel('provider/not-configured'), /not in the current TrueForge catalog/);

  workspaceFolders[0] = { name: 'workspace-b',
    uri: { scheme: 'file', fsPath: '/tmp/secureforge-workspace-b' } };
  const b = await commands.get('secureforge.refreshModels')();
  assert.equal(b.selected, '');
  await state.selectModel('provider/model-b');
  assert.equal(events.at(-1).selected, 'provider/model-b');
  assert.equal(storage.size, 2, 'Both workspaces have independent remembered model selections');

  workspaceFolders[0] = { name: 'workspace-a',
    uri: { scheme: 'file', fsPath: '/tmp/secureforge-workspace-a' } };
  const restored = await state.refreshModels();
  assert.equal(restored.selected, 'provider/model-a');
  assert.ok(fetched.every(url => url === 'http://localhost:8790'));
  await state.newConversation();
  assert.deepEqual(events.at(-1), {
    type: 'conversationState', count: 0,
    message: 'Conversation context cleared. Pending code reviews remain independent.',
  });
  assert.deepEqual(notices, []);
});

test('catalog failure surfaces actionable category without exposing upstream body', async () => {
  let listener;
  const vscode = {
    commands: { registerCommand: () => ({ dispose() {} }) },
    workspace: {
      isTrusted: true, workspaceFolders: [{
        name: 'offline', uri: { scheme: 'file', fsPath: '/tmp/secureforge-offline' },
      }],
      getConfiguration: () => ({ get: (_, fallback) => fallback }),
    },
    window: {
      createOutputChannel: () => ({ dispose() {}, appendLine() {} }),
      registerWebviewViewProvider: () => ({ dispose() {} }),
    },
  };
  const state = registerWorkflows(vscode, { subscriptions: [] }, {
    modelCatalog: async () => { throw Object.assign(new Error('upstream secret'), { status: 429 }); },
  });
  const events = [];
  state.subscribe(event => events.push(event));
  const result = await state.refreshModels();
  assert.equal(result.error.kind, 'rate_limit');
  assert.match(events.at(-1).message, /Retry later/);
  assert.doesNotMatch(events.at(-1).message, /upstream secret/);
});
