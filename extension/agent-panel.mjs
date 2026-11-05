import { randomBytes } from 'node:crypto';

export function registerAgentPanel(vscode, context, actions) {
  function attach(view) {
    const panel = view;
    panel.webview.options = { enableScripts: true, localResourceRoots: [] };
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
      let finalStatus = 'Build finished. If a patch was proposed, the Review Changes window opens separately.';
      try { await actions.run(message.task); }
      catch (error) { finalStatus = error.message; }
      finally {
        running = false;
        if (!disposed) panel.webview.postMessage({ type: 'status', message: finalStatus, running: false });
      }
    });
    const workspaceLabel = (vscode.workspace?.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0].uri.fsPath : 'Choose your target project when you run Build');
    panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>SecureForge</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{font:14px/1.55 var(--vscode-font-family);width:100%;max-width:none;margin:0;padding:16px 12px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
h1{font-size:22px;margin:0;font-weight:700;letter-spacing:-.6px}h2{font-size:17px;margin:0 0 8px}p{margin:5px 0 12px}.muted{color:var(--vscode-descriptionForeground)}
.hero{display:flex;align-items:center;gap:15px;margin-bottom:14px}.logo{width:36px;height:36px;border-radius:12px;display:grid;place-items:center;font-weight:800;font-size:19px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.card{border:1px solid var(--vscode-panel-border);border-radius:12px;padding:14px;margin:12px 0;background:var(--vscode-sideBar-background)}
label{font-size:15px;font-weight:650;display:block;margin-bottom:8px}textarea{display:block;width:100%;min-height:128px;resize:vertical;font:inherit;line-height:1.5;padding:14px;border-radius:8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}
textarea:focus-visible,button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
button{font:inherit;font-weight:600;border:1px solid var(--vscode-button-border,transparent);border-radius:7px;padding:10px 15px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:disabled{opacity:.5;cursor:not-allowed}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px}.toolbar button{margin:0}
.workspace{border-left:3px solid var(--vscode-focusBorder);padding-left:12px;margin-bottom:18px;font-size:14px}
.steps{display:grid;grid-template-columns:1fr;gap:8px;margin:16px 0}.step{padding:11px 12px;border:1px solid var(--vscode-panel-border);border-radius:8px;color:var(--vscode-descriptionForeground);font-weight:600}.step.active{border-color:var(--vscode-focusBorder);color:var(--vscode-foreground)}.step.complete:before{content:"✓ ";color:var(--vscode-testing-iconPassed,#4caf50)}
.status{padding:12px 14px;border-radius:8px;background:var(--vscode-textCodeBlock-background);min-height:45px;overflow-wrap:anywhere}
details{margin-top:14px}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--vscode-textCodeBlock-background);padding:12px;max-height:280px;overflow:auto;font-size:12px}
.tip{font-size:13px;color:var(--vscode-descriptionForeground);margin-top:12px}
@media(max-width:540px){body{padding:14px}.steps{grid-template-columns:1fr}.card{padding:14px}}
</style></head><body>
<div class="hero"><div class="logo" aria-hidden="true">S</div><div><h1>SecureForge</h1><p class="muted">Describe a change. Review every edit before it reaches your files.</p></div></div>
<section class="card" aria-label="Build a change">
<div class="workspace"><strong>Working folder</strong><div id="workspaceName">${workspaceLabel.replace(/[&<>"']/g, '')}</div><span class="muted">Check this matches the project you intend to edit.</span></div>
<label for="task">What would you like to change?</label>
<textarea id="task" maxlength="20000" placeholder="Example: Fix environment variable parsing and add regression tests."></textarea>
<div class="toolbar"><button id="run">Find and propose changes</button><button id="cancel" class="secondary" disabled>Stop</button><button id="file" class="secondary">+ File context</button><button id="symbol" class="secondary">+ Symbol</button></div>
<p class="tip">Your files are not automatically changed. You decide which proposals to accept in the review window.</p>
</section>
<section class="card" aria-label="Progress"><h2>Where am I?</h2>
<div class="steps" aria-label="Build stages"><div class="step active" id="step1">1. Describe</div><div class="step" id="step2">2. Investigate</div><div class="step" id="step3">3. Review changes</div></div>
<div id="status" class="status" role="status" aria-live="polite">Ready. Enter a task and click “Find and propose changes”.</div>
<p class="tip" id="next">After the agent proposes a patch, SecureForge opens a separate Review Changes window. Approve or reject each change there; then save and run tests.</p>
<details><summary>Files the agent looked at</summary><pre id="context">No context collected yet.</pre></details>
<details><summary>Technical activity (for troubleshooting)</summary><pre id="activity" aria-live="off">No activity yet.</pre></details>
</section>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const task = document.getElementById('task');
const runButton = document.getElementById('run');
const cancelButton = document.getElementById('cancel');
const status = document.getElementById('status');
const activity = document.getElementById('activity');
const workspaceName = document.getElementById('workspaceName');
const steps = [1,2,3].map(i => document.getElementById('step'+i));
let running = false;
let sawProposal = false;
function stage(n) { steps.forEach((el,i)=>{el.classList.toggle('active',i===n-1);el.classList.toggle('complete',i<n-1);}); }

runButton.onclick = () => {
  if (!task.value.trim() || running) { if(!task.value.trim()) status.textContent='Describe the change first.'; return; }
  activity.textContent='';sawProposal=false;stage(2);
  status.textContent='Preparing your project context…';
  vscode.postMessage({type:'run',task:task.value});
};
cancelButton.onclick = () => vscode.postMessage({type:'cancel'});
document.getElementById('file').onclick = () => vscode.postMessage({type:'attachFile'});
document.getElementById('symbol').onclick = () => vscode.postMessage({type:'attachSymbol'});
window.addEventListener('message', event => {
 const message = event.data;
 if (!message || typeof message !== 'object') return;
 if (message.type === 'status') {
   running = Boolean(message.running);
   runButton.disabled = running; cancelButton.disabled = !running;
   document.getElementById('file').disabled = running;
   document.getElementById('symbol').disabled = running;
   if (running) { stage(2); status.textContent='Investigating your project and preparing safe proposals…'; }
   else {
     stage(sawProposal ? 3 : 1);
     status.textContent = sawProposal ? 'Proposal submitted for review. Look for the separate Review Changes window.' : message.message;
   }
 }
 if (message.type === 'error') {status.textContent=message.message;stage(1);}
 if (message.type === 'context') document.getElementById('context').textContent=message.summary;
 if (message.type === 'attachment') task.value += ' ' + message.mention;
 if (message.type === 'reviewReady') { sawProposal = true; stage(3); status.textContent='Review Changes opened in another editor pane. Approve or reject each change there.'; }
 if (message.type === 'activity') {
   const line=String(message.text || '');
   activity.textContent=(activity.textContent+line+'\\n').slice(-64000);
   activity.scrollTop=activity.scrollHeight;

   if (running && /discover_repository: started|read_source_bundle: started/.test(line)) status.textContent='Finding the right source files…';
   if (running && /propose_(patch_batch|batch|edit): started/.test(line)) status.textContent='Preparing a reviewable patch…';
 }
});
</script></body></html>`;
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    'secureforge.agentSidebar',
    { resolveWebviewView: attach },
    { webviewOptions: { retainContextWhenHidden: true } },
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    'secureforge.openAgentPanel',
    () => vscode.commands.executeCommand('secureforge.agentSidebar.focus'),
  ));
}
