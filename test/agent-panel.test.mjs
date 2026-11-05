import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { registerAgentPanel } from '../extension/agent-panel.mjs';

test('agent panel emits valid script, bounds tasks and surfaces run failures', async () => {
  let open;
  let receive;
  let provider;
  let options;
  const commands = [];
  const messages = [];
  const panel = {
    onDidDispose() {},
    webview: {
      postMessage: message => messages.push(message),
      onDidReceiveMessage: handler => { receive = handler; },
    },
  };
  const vscode = {
    commands: {
      registerCommand: (_name, handler) => { open = handler; return {}; },
      executeCommand: async name => { commands.push(name); },
    },
    window: { registerWebviewViewProvider: (_id, item, opts) => { provider = item; options = opts; return {}; } },
    workspace: { workspaceFolders: [{ uri: { fsPath: '/tmp/flask' } }] },
  };
  let runs = 0;
  let cancels = 0;
  registerAgentPanel(vscode, { subscriptions: [] }, {
    subscribe: () => ({ dispose() {} }),
    run: async () => { runs++; throw new Error('Model unavailable'); },
    cancel: async () => { cancels++; },
  });
  await open();
  assert.deepEqual(commands, ['secureforge.agentSidebar.focus']);
  assert.equal(options.webviewOptions.retainContextWhenHidden, true);
  provider.resolveWebviewView(panel);
  assert.equal(panel.webview.options.enableScripts, true);
  assert.match(panel.webview.html, /\/tmp\/flask/);
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Script(script));
  assert.match(panel.webview.html, /Ask SecureForge to work on your code/);
  assert.match(panel.webview.html, /Technical details/);
  assert.match(panel.webview.html, /Build with confidence/);
  assert.match(panel.webview.html, /SecureForge shield logo/);
  assert.match(panel.webview.html, /reviewReady/);
  await receive({ type: 'run', task: 'x'.repeat(20001) });
  assert.equal(runs, 0);
  await receive({ type: 'run', task: 'Update docstring' });
  assert.equal(runs, 1);
  assert.match(messages.at(-1).message, /Model unavailable/);
  await receive({ type: 'cancel' });
  assert.equal(cancels, 1);
});
