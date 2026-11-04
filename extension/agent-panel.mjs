import { randomBytes } from 'node:crypto';

export function registerAgentPanel(vscode, context, actions) {
  context.subscriptions.push(vscode.commands.registerCommand('secureforge.openAgentPanel', () => {
    const panel = vscode.window.createWebviewPanel('secureforge.agent', 'SecureForge Agent', vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    const nonce = randomBytes(16).toString('hex');
    let running = false;
    let disposed = false;
    const subscription = actions.subscribe(event => { if (!disposed) panel.webview.postMessage(event); });
    panel.onDidDispose(() => { disposed = true; subscription.dispose(); if (running) void actions.cancel(); });
    panel.webview.onDidReceiveMessage(async message => {
      if (disposed || !message || typeof message !== 'object') return;
      if (message.type === 'cancel') { await actions.cancel(); return; }
      if (message.type === 'attachFile' || message.type === 'attachSymbol') {
        const mention = await (message.type === 'attachFile' ? actions.attachFile() : actions.attachSymbol());
        if (mention && !disposed) panel.webview.postMessage({ type: 'attachment', mention });
        return;
      }
      if (message.type !== 'run' || running || typeof message.task !== 'string' || !message.task.trim() || message.task.length > 20000) return;
      running = true;
      panel.webview.postMessage({ type: 'status', message: 'Running', running: true });
      let finalStatus = 'Idle. Review any returned proposals before applying.';
      try { await actions.run(message.task); }
      catch (error) { finalStatus = error.message; }
      finally {
        running = false;
        if (!disposed) panel.webview.postMessage({ type: 'status', message: finalStatus, running: false });
      }
    });
    context.subscriptions.push(panel);
    panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>SecureForge Agent</title>
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
textarea{width:95%;min-height:100px;padding:10px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}
button{margin:8px 8px 8px 0;padding:8px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;cursor:pointer}button:disabled{opacity:.5}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--vscode-textCodeBlock-background);padding:12px;max-height:50vh;overflow:auto}
</style></head><body><h1>SecureForge</h1><p>Build with local TrueForge. Every proposed source change opens for human hunk review.</p>
<label for="task">Repository task</label><textarea id="task" placeholder="Describe the task. Optional @file:path or @symbol:name"></textarea><br>
<button id="run">Run agent</button><button id="cancel" disabled>Cancel</button><button id="file">Attach file</button><button id="symbol">Attach symbol</button>
<p id="status" role="status">Idle</p><h2>Selected context</h2><pre id="context">Context appears after retrieval.</pre><h2>Live activity</h2><pre id="activity" aria-live="polite"></pre>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const task = document.getElementById('task');
const runButton = document.getElementById('run');
const cancelButton = document.getElementById('cancel');
runButton.onclick = () => {
  document.getElementById('activity').textContent = '';
  vscode.postMessage({ type: 'run', task: task.value });
};
cancelButton.onclick = () => vscode.postMessage({ type: 'cancel' });
document.getElementById('file').onclick = () => vscode.postMessage({ type: 'attachFile' });
document.getElementById('symbol').onclick = () => vscode.postMessage({ type: 'attachSymbol' });
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'status') {
    document.getElementById('status').textContent = message.message;
    runButton.disabled = message.running;
    cancelButton.disabled = !message.running;
  }
  if (message.type === 'context') {
    document.getElementById('context').textContent = message.summary;
  }
  if (message.type === 'attachment') task.value += ' ' + message.mention;
  if (message.type === 'activity') {
    const log = document.getElementById('activity');
    log.textContent = (log.textContent + message.text + '\\n').slice(-64000);
    log.scrollTop = log.scrollHeight;
  }
});
</script></body></html>`;
    return panel;
  }));
}
