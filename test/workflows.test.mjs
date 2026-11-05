import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/workspace.mjs';
import { registerWorkflows } from '../extension/workflows.mjs';

test('standalone verification cancellation uses its own controller without an active Build', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-workflow-'));
  await writeFile(path.join(root, 'sample.test.mjs'), "throw new Error('must never execute');\n");
  const workspace = await new Workspace(root).init();
  t.after(async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); });
  let cancel;
  const output = { appendLine() {}, show() {}, dispose() {} };
  const vscode = {
    commands: { registerCommand: () => ({ dispose() {} }) },
    ProgressLocation: { Notification: 1 },
    window: {
      createOutputChannel: () => output,
      registerWebviewViewProvider: (_id, _provider, options) => {
        assert.equal(options.webviewOptions.retainContextWhenHidden, true);
        return { dispose() {} };
      },
      withProgress: async (_options, callback) => callback({}, {
        onCancellationRequested: handler => { cancel = handler; return { dispose() {} }; },
      }),
      showWarningMessage: async () => { cancel(); return 'Run verification'; },
    },
  };
  const state = registerWorkflows(vscode, { subscriptions: [] });
  await assert.rejects(state.runCheck(workspace, { executable: 'node', args: ['--test', 'sample.test.mjs'] }),
    error => error.name === 'AbortError');
  assert.equal(state.receipts.length, 0);
});

test('command failures reach the activity subscribers and visible notification', async () => {
  const handlers = new Map();
  const notifications = [];
  const navigation = [];
  const vscode = {
    commands: {
      registerCommand: (name, handler) => { handlers.set(name, handler); return { dispose() {} }; },
      executeCommand: async name => { navigation.push(name); },
    },
    workspace: { isTrusted: false },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      registerWebviewViewProvider: (_id, _provider, options) => {
        assert.equal(options.webviewOptions.retainContextWhenHidden, true);
        return { dispose() {} };
      },
      showErrorMessage: message => notifications.push(message),
    },
  };
  const state = registerWorkflows(vscode, { subscriptions: [] });
  const events = [];
  const subscription = state.subscribe(event => events.push(event));
  await handlers.get('secureforge.runBuild')('Update the docstring');
  assert.match(notifications[0], /trusted local workspace/);
  assert.deepEqual(events, [{ type: 'error', message: 'A trusted local workspace is required' }]);
  await handlers.get('secureforge.runBuild')();
  assert.deepEqual(navigation, ['secureforge.openAgentPanel']);
  state.recordReview({ group: { id: 'test', files: [
    { id: 'one', path: 'sample.py', baseSha256: 'sha', hunks: [{ id: 'h1', startLine: 1 }] },
  ] }, result: { status: 'applied', accepted: 1 } });
  assert.deepEqual(events.at(-1), { type: 'reviewResult', status: 'applied', accepted: 1 });
  subscription.dispose();
});

test('wrong Flask repository is rejected before creating a TrueForge client', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-wrong-folder-'));
  await writeFile(path.join(root, 'server.js'), 'export const app = true;\n');
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const handlers = new Map();
  const notifications = [];
  const vscode = {
    commands: { registerCommand: (name, handler) => {
      handlers.set(name, handler); return { dispose() {} };
    } },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ name: 'node-project', uri: { scheme: 'file', fsPath: root } }],
      getConfiguration: () => ({ get: (_name, fallback) => fallback }),
    },
    ProgressLocation: { Notification: 1 },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, clear() {}, dispose() {} }),
      registerWebviewViewProvider: () => ({ dispose() {} }),
      withProgress: async (_options, callback) => callback({}, {
        onCancellationRequested: () => ({ dispose() {} }),
      }),
      showErrorMessage: message => notifications.push(message),
    },
  };
  const state = registerWorkflows(vscode, { subscriptions: [] });
  const events = [];
  state.subscribe(event => events.push(event));
  const result = await handlers.get('secureforge.runBuild')(
    'Fix FLASK_DEBUG and FLASK_SKIP_DOTENV in the existing parser');
  assert.equal(result.status, 'workspace_mismatch');
  assert.equal(events.find(item => item.type === 'workspaceMismatch')?.code, 'FLASK_SOURCE_ABSENT');
  assert.deepEqual(notifications, []);
});
