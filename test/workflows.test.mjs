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
  const vscode = {
    commands: { registerCommand: (name, handler) => { handlers.set(name, handler); return { dispose() {} }; } },
    workspace: { isTrusted: false },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showErrorMessage: message => notifications.push(message),
    },
  };
  const state = registerWorkflows(vscode, { subscriptions: [] });
  const events = [];
  const subscription = state.subscribe(event => events.push(event));
  await handlers.get('secureforge.runBuild')('Update the docstring');
  assert.match(notifications[0], /trusted local workspace/);
  assert.deepEqual(events, [{ type: 'error', message: 'A trusted local workspace is required' }]);
  subscription.dispose();
});
