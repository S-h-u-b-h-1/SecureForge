import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { registerAgentPanel } from '../extension/agent-panel.mjs';

test('agent panel emits valid script, bounds tasks and surfaces run failures', async () => {
  let open;
  let receive;
  const messages = [];
  const panel = {
    onDidDispose() {},
    webview: {
      postMessage: message => messages.push(message),
      onDidReceiveMessage: handler => { receive = handler; },
    },
  };
  const vscode = {
    commands: { registerCommand: (_name, handler) => { open = handler; return {}; } },
    window: { createWebviewPanel: () => panel }, ViewColumn: { One: 1 },
  };
  let runs = 0;
  let cancels = 0;
  registerAgentPanel(vscode, { subscriptions: [] }, {
    subscribe: () => ({ dispose() {} }),
    run: async () => { runs++; throw new Error('Model unavailable'); },
    cancel: async () => { cancels++; },
  });
  open();
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Script(script));
  assert.match(panel.webview.html, /Working folder/);
  assert.match(panel.webview.html, /Find and propose changes/);
  assert.match(panel.webview.html, /Review Changes window/);
  assert.match(panel.webview.html, /Technical activity \(for troubleshooting\)/);
  assert.match(panel.webview.html, /reviewReady/);
  await receive({ type: 'run', task: 'x'.repeat(20001) });
  assert.equal(runs, 0);
  await receive({ type: 'run', task: 'Update docstring' });
  assert.equal(runs, 1);
  assert.match(messages.at(-1).message, /Model unavailable/);
  await receive({ type: 'cancel' });
  assert.equal(cancels, 1);
});
