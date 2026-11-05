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
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--vscode-sideBar-background);color:var(--vscode-foreground);font:13px/1.5 var(--vscode-font-family)}
body{display:flex;flex-direction:column;overflow:hidden}
button{border:0;background:none;color:inherit;cursor:pointer;font:inherit}
button:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
button:disabled{opacity:.45;cursor:not-allowed}
.top{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
.top strong{font-weight:650;font-size:13px;letter-spacing:.1px}.brand{display:flex;align-items:center;gap:9px}.brand svg{width:22px;height:22px}
.top button{padding:5px 8px;border-radius:7px;color:var(--vscode-descriptionForeground)}.top button:hover,.mini:hover{background:var(--vscode-toolbar-hoverBackground)}
#thread{flex:1;min-height:0;overflow:auto;padding:14px 14px 18px;scrollbar-width:thin}
.welcome{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:14px 3px 30px;gap:10px}
.emblem{width:72px;height:72px;filter:drop-shadow(0 0 17px rgba(142,119,255,.26))}
.emblem .orbit{transform-origin:center;animation:orbit 6s linear infinite}
@keyframes orbit{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.emblem .orbit{animation:none}}
.welcome h1{font-size:21px;letter-spacing:-.4px;margin:0}.welcome p{max-width:260px;color:var(--vscode-descriptionForeground);margin:0}
.chips{display:flex;flex-wrap:wrap;justify-content:center;gap:7px;margin-top:10px}
.chip{border:1px solid var(--vscode-panel-border);border-radius:16px;padding:6px 10px;font-size:12px}
.chip:hover{background:var(--vscode-list-hoverBackground)}
.message{margin:12px 0;padding:11px 12px;border-radius:12px;overflow-wrap:anywhere;white-space:pre-wrap}
.message.user{margin-left:28px;background:var(--vscode-textBlockQuote-background);border:1px solid var(--vscode-panel-border)}
.message.agent{margin-right:15px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border)}
.message .who{font-size:11px;font-weight:700;color:var(--vscode-descriptionForeground);margin-bottom:5px}
#dock{flex-shrink:0;padding:10px 11px 13px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}
#status{font-size:11px;color:var(--vscode-descriptionForeground);margin:0 3px 8px;min-height:15px;overflow-wrap:anywhere}
.composer{border:1px solid var(--vscode-input-border,var(--vscode-panel-border));background:var(--vscode-input-background);border-radius:12px;padding:9px 9px 7px}
textarea{width:100%;min-height:48px;max-height:160px;resize:vertical;border:0;outline:none!important;background:transparent;color:var(--vscode-input-foreground);font:13px/1.5 var(--vscode-font-family);display:block}
.composerBar{display:flex;align-items:center;gap:5px;min-width:0}
.mini{padding:6px 8px;border-radius:7px;font-size:12px}
#folder{margin-left:auto;color:var(--vscode-descriptionForeground);font-size:11px;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.send{height:30px;min-width:32px;border-radius:8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:17px;font-weight:700;display:grid;place-items:center}
#cancel{color:var(--vscode-errorForeground)}
details{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:8px}pre{max-height:155px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.hidden{display:none!important}
</style></head><body>
<header class="top"><div class="brand"><svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="sf" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#71c7ff"/><stop offset="1" stop-color="#a18aff"/></linearGradient></defs><path d="M32 5 54 14v18c0 13-9 21-22 27C19 53 10 45 10 32V14Z" fill="none" stroke="url(#sf)" stroke-width="5" stroke-linejoin="round"/><path d="m26 24-8 8 8 8m12-16 8 8-8 8m-10-22-7 28" fill="none" stroke="url(#sf)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><strong>SecureForge</strong></div><button id="new" aria-label="New task" title="New task">＋</button></header>
<main id="thread" role="log" aria-label="SecureForge conversation" aria-live="polite">
<div class="welcome" id="welcome">
<svg class="emblem" viewBox="0 0 96 96" role="img" aria-label="SecureForge shield logo"><defs><linearGradient id="glow" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#61c7ff"/><stop offset=".55" stop-color="#878bff"/><stop offset="1" stop-color="#bb85f7"/></linearGradient></defs><ellipse class="orbit" cx="48" cy="48" rx="43" ry="16" transform="rotate(-30 48 48)" fill="none" stroke="url(#glow)" opacity=".45" stroke-width="2"/><path d="M48 10 77 22v25c0 18-12 30-29 39C31 77 19 65 19 47V22Z" fill="none" stroke="url(#glow)" stroke-width="5" stroke-linejoin="round"/><path d="m39 36-11 12 11 12m18-24 11 12-11 12m-17-30-8 36" stroke="url(#glow)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
<h1>Build with confidence</h1><p>Ask for a fix or improvement. I'll inspect this workspace and prepare changes for your review.</p>
<div class="chips"><button class="chip" data-prompt="Find and fix a bug in this project">Fix a bug</button><button class="chip" data-prompt="Explain the currently open code and identify improvements">Explain code</button><button class="chip" data-prompt="Add regression tests for this code">Add tests</button></div>
</div></main>
<footer id="dock"><div id="status" role="status">Ready · Changes require your approval</div>
<div class="composer"><textarea id="task" rows="2" maxlength="20000" aria-label="Ask SecureForge" placeholder="Ask SecureForge to work on your code…"></textarea>
<div class="composerBar">
<button id="file" class="mini" title="Attach file context" aria-label="Attach file context">＋ File</button>
<button id="symbol" class="mini" title="Attach symbol" aria-label="Attach symbol">@</button>
<button id="cancel" class="mini hidden" title="Stop run">Stop</button>
<span id="folder" title="${workspaceLabel.replace(/[&<>"']/g, '')}">${workspaceLabel.split(/[\\/]/).filter(Boolean).at(-1) || 'Workspace'}</span>
<button id="run" class="send" title="Send task" aria-label="Send task">↑</button>
</div></div>
<details><summary>Technical details</summary><div id="context"></div><pre id="activity"></pre></details>
</footer>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(), task=document.getElementById('task'), status=document.getElementById('status'), thread=document.getElementById('thread'), welcome=document.getElementById('welcome'), run=document.getElementById('run'), cancel=document.getElementById('cancel');
let busy=false,review=false;
function msg(role,value){welcome?.remove();const box=document.createElement('div');box.className='message '+role;const who=document.createElement('div');who.className='who';who.textContent=role==='user'?'You':'SecureForge';const body=document.createElement('div');body.textContent=String(value).slice(0,4000);box.append(who,body);thread.append(box);thread.scrollTop=thread.scrollHeight;}
function submit(){const value=task.value.trim();if(!value||busy)return;review=false;msg('user',value);task.value='';status.textContent='Inspecting your workspace…';vscode.postMessage({type:'run',task:value});}
run.onclick=submit;task.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit();}};
cancel.onclick=()=>vscode.postMessage({type:'cancel'});
document.getElementById('file').onclick=()=>vscode.postMessage({type:'attachFile'});
document.getElementById('symbol').onclick=()=>vscode.postMessage({type:'attachSymbol'});
document.getElementById('new').onclick=()=>{if(busy)return;thread.replaceChildren();thread.append(welcome);task.value='';task.focus();status.textContent='Ready · Changes require your approval';};
document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{task.value=b.dataset.prompt;task.focus();});
window.addEventListener('message',e=>{const m=e.data;if(!m||typeof m!=='object')return;
if(m.type==='status'){busy=Boolean(m.running);run.disabled=busy;cancel.classList.toggle('hidden',!busy);if(busy){status.textContent='Working on your code…';}else{status.textContent=review?'Changes ready for review':m.message;if(!review)msg('agent',m.message);}}
if(m.type==='reviewReady'){review=true;msg('agent','I prepared changes in your project. Review them in the editor and approve only what you want to apply.');status.textContent='Review changes in editor';}
if(m.type==='error'){status.textContent=m.message;msg('agent',m.message);}
if(m.type==='attachment'){task.value+=(task.value?' ':'')+m.mention;task.focus();}
if(m.type==='context')document.getElementById('context').textContent=m.summary;
if(m.type==='activity'){const line=String(m.text||'');const a=document.getElementById('activity');a.textContent=(a.textContent+line+'\\n').slice(-32000);if(busy&&/discover_repository: started/.test(line))status.textContent='Finding relevant files…';if(busy&&/propose_(patch_batch|batch|edit): started/.test(line))status.textContent='Preparing safe edits…';}
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
