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
  assert.match(events.find(item => item.type === 'workspaceMismatch').message, /currently in node-project/);
  assert.match(events.find(item => item.type === 'workspaceMismatch').message, /Recent projects/);
  assert.deepEqual(notifications, []);
});

test('verification UI selects multiple repository test files, runs only after approval and reports status', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-verify-ui-'));
  await writeFile(path.join(root, 'one.test.mjs'),
    "import test from 'node:test'; test('one', () => {});\n");
  await writeFile(path.join(root, 'two.spec.mjs'),
    "import test from 'node:test'; test('two', () => {});\n");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const commands = new Map();
  const prompts = [];
  const emitted = [];
  const output = { appendLine() {}, show() {}, dispose() {} };
  const vscode = {
    commands: { registerCommand: (name, handler) => {
      commands.set(name, handler); return { dispose() {} };
    } },
    ProgressLocation: { Notification: 1 },
    workspace: { isTrusted: true,
      workspaceFolders: [{ name: 'test-repo', uri: { scheme: 'file', fsPath: root } }],
    },
    window: {
      createOutputChannel: () => output,
      registerWebviewViewProvider: () => ({ dispose() {} }),
      showQuickPick: async (items, options) => {
        if (!options.canPickMany) return 'Node test';
        assert.deepEqual(items.map(item => item.label).sort(), ['one.test.mjs', 'two.spec.mjs']);
        return items;
      },
      withProgress: async (_options, callback) => callback({}, {
        onCancellationRequested: () => ({ dispose() {} }),
      }),
      showWarningMessage: async (_prompt, options) => {
        prompts.push(options.detail);
        return 'Run verification';
      },
    },
  };
  const state = registerWorkflows(vscode, { subscriptions: [] });
  state.subscribe(value => emitted.push(value));
  const receipt = await commands.get('secureforge.runVerification')();
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.executed, true);
  assert.ok(receipt.command.args.includes('one.test.mjs'));
  assert.ok(receipt.command.args.includes('two.spec.mjs'));
  assert.equal(prompts.length, 1, 'Execution still requires one explicit local approval');
  assert.deepEqual(emitted.at(-1), {
    type: 'verificationResult', status: 'passed', executed: true, fileCount: 2,
  });
});

test('opening only Flask src/flask stops before TrueForge and offers correct root guidance', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-flask-package-'));
  for (const file of ['__init__.py', 'helpers.py', 'cli.py']) {
    await writeFile(path.join(root, file), 'from __future__ import annotations\n');
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map();
  const errors = [];
  const vscode = {
    commands: { registerCommand: (name, handler) => {
      handlers.set(name, handler); return { dispose() {} };
    } },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ name: 'flask', uri: { scheme: 'file', fsPath: root } }],
      getConfiguration: () => ({ get: (_name, fallback) => fallback }),
    },
    ProgressLocation: { Notification: 1 },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, clear() {}, dispose() {} }),
      registerWebviewViewProvider: () => ({ dispose() {} }),
      withProgress: async (_options, callback) => callback({}, {
        onCancellationRequested: () => ({ dispose() {} }),
      }),
      showErrorMessage: message => errors.push(message),
    },
  };
  const state = registerWorkflows(vscode, { subscriptions: [] });
  const events = [];
  state.subscribe(event => events.push(event));
  const result = await handlers.get('secureforge.runBuild')(
    'Fix existing FLASK_DEBUG and FLASK_SKIP_DOTENV parsing and add regression tests');
  assert.equal(result.status, 'workspace_mismatch');
  const mismatch = events.find(event => event.type === 'workspaceMismatch');
  assert.equal(mismatch.code, 'FLASK_PACKAGE_SUBFOLDER');
  assert.match(mismatch.message, /two folders above/);
  assert.deepEqual(errors, []);
});
