import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { Workspace, sha256 } from '../src/workspace.mjs';
import { ProposalStore } from '../src/proposals.mjs';
import { createReviewGroup } from '../src/review-group.mjs';
import { applyReviewGroup, undoReviewGroup } from './apply-review.mjs';

export function registerReviewCommands(vscode, context) {
  async function openReview(demo) {
    if (!vscode.workspace.isTrusted) throw new Error('Open a trusted local workspace');
    const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file');
    if (!folders?.length) throw new Error('Open a local project folder first');
    const choice = folders.length === 1 ? { folder: folders[0] } : await vscode.window.showQuickPick(
      folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { title: 'Choose the workspace for this review' }
    );
    if (!choice) return;
    let proposal;
    if (!demo) {
      const selected = await vscode.window.showOpenDialog({
        title: 'Open an exported SecureForge v1 proposal',
        canSelectMany: false,
        filters: { 'Proposal JSON': ['json'] },
      });
      if (!selected?.length) return;
      if (selected[0].scheme !== 'file' || (await stat(selected[0].fsPath)).size > 4 * 1024 * 1024) {
        throw new Error('Proposal JSON must be a local file no larger than 4 MiB');
      }
      const json = await readFile(selected[0].fsPath, 'utf8');
      if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new Error('Proposal JSON exceeds 4 MiB');
      proposal = JSON.parse(json);
    }
    const workspace = await new Workspace(choice.folder.uri.fsPath).init();
    try {
      if (demo) {
        const source = await workspace.rawForProposal('fixtures/review-demo.py');
        if (!source.raw.includes('return "Hello"') || !source.raw.includes('return "Ready"')) {
          throw new Error('Demo fixture changed. Restore fixtures/review-demo.py before preparing another demo.');
        }
        const store = new ProposalStore(workspace);
        const summary = await store.proposeEdit({
          path: source.relative,
          expectedSha256: source.hash,
          proposedContent: source.raw.replace('return "Hello"', 'return "Hello, developer"')
            .replace('return "Ready"', 'return "Ready for review"'),
          rationale: 'Local synthetic review demo. Independently accept or reject the two changes.',
        });
        proposal = store.getProposal(summary.id);
      }
      await openReviewPayload(vscode, context, workspace, proposal);
    } catch (error) {
      await workspace.close();
      throw error;
    }
  }
  for (const [command, demo] of [['secureforge.reviewProposal', false], ['secureforge.reviewDemo', true]]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
      try {
        await openReview(demo);
      } catch (error) {
        // File contents and tool payloads must not enter error notifications.
        const message = error instanceof SyntaxError ? 'Invalid proposal JSON' : error.message;
        vscode.window.showErrorMessage(`SecureForge: ${message}`);
      }
    }));
  }
}

export async function openReviewPayload(vscode, context, workspace, proposal, onApplied = () => {}) {
  const group = createReviewGroup(proposal);
  const entries = [];
  for (const review of group.files) {
    const source = await workspace.rawForProposal(review.path);
    if (source.hash !== review.baseSha256) throw new Error('Stale proposal: source file changed');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.resolve(workspace.root, review.path)));
    if (document.isDirty || sha256(document.getText()) !== review.baseSha256) {
      throw new Error('Save or undo existing editor changes before opening this proposal');
    }
    entries.push({ document, review, baseVersion: document.version });
  }
  await vscode.window.showTextDocument(entries[0].document, vscode.ViewColumn.One);
  return showReview(vscode, context, workspace, entries, group, onApplied);
}

function showReview(vscode, context, workspace, entries, group, onApplied) {
  const panel = vscode.window.createWebviewPanel('secureforge.review', 'SecureForge Review', vscode.ViewColumn.Beside, {
    enableScripts: true,
    localResourceRoots: [],
    retainContextWhenHidden: true,
  });
  const controller = new AbortController();
  const hunks = group.files.flatMap(review => review.hunks.map(hunk => ({ ...hunk, path: review.path })));
  const decisions = Object.create(null);
  let status = 'pending';
  let appliedReceipt;
  let disposed = false;
  const knownIds = new Set(hunks.map(hunk => hunk.id));
  function send(message) {
    if (!disposed) panel.webview.postMessage(message);
  }
  const changes = vscode.workspace.onDidChangeTextDocument(event => {
    if (status === 'pending' && entries.some(entry => event.document === entry.document && entry.document.version !== entry.baseVersion)) {
      status = 'stale';
      send({ type: 'status', status, message: 'The document changed. Prepare a new proposal.' });
    }
  });
  const messages = panel.webview.onDidReceiveMessage(async message => {
    if (disposed || !message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      send({ type: 'review', path: group.files.map(file => file.path).join(', '),
        rationale: group.files.map(file => file.rationale).filter(Boolean).join('\n'), hunks });
      send({ type: 'status', status, message: 'Decide every hunk, then apply. Changes remain unsaved and support native Undo.' });
    } else if (message.type === 'decision' && status === 'pending' && knownIds.has(message.id) &&
        ['accept', 'reject'].includes(message.decision)) {
      decisions[message.id] = message.decision;
    } else if (message.type === 'discard' && status === 'pending') {
      status = 'discarded';
      send({ type: 'status', status, message: 'Proposal discarded.' });
    } else if (message.type === 'apply' && status === 'pending') {
      if (hunks.some(hunk => !Object.hasOwn(decisions, hunk.id))) {
        send({ type: 'status', status, message: 'Accept or reject every hunk first.' });
        return;
      }
      status = 'applying';
      send({ type: 'status', status, message: 'Validating document and applying approved hunks…' });
      try {
        const result = await applyReviewGroup({ vscode, workspace, entries, decisions, signal: controller.signal });
        appliedReceipt = result;
        status = result.status;
        await onApplied({ group, decisions: { ...decisions }, result });
        send({ type: 'status', status, message: result.status === 'applied'
          ? `Applied ${result.accepted} hunk(s). Save when ready. Use Undo in the source editor to reverse the edit.`
          : 'All hunks rejected. The document was not edited.' });
      } catch (error) {
        status = 'blocked';
        send({ type: 'status', status, message: error.message });
      }
    } else if (message.type === 'undo' && status === 'applied') {
      status = 'undoing';
      try {
        await undoReviewGroup({ vscode, workspace, entries, receipt: appliedReceipt });
        status = 'undone';
        send({ type: 'status', status, message: 'Accepted changes undone in the editor.' });
      } catch (error) {
        status = 'blocked';
        send({ type: 'status', status, message: error.message });
      }
    }
  });
  panel.onDidDispose(() => {
    disposed = true;
    controller.abort();
    changes.dispose();
    messages.dispose();
    void workspace.close();
  });
  context.subscriptions.push(panel);
  panel.webview.html = reviewHtml();
  return panel;
}

function reviewHtml() {
  const nonce = randomBytes(18).toString('base64');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SecureForge Review</title>
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
article { border: 1px solid var(--vscode-panel-border); padding: 12px; margin: 16px 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; background: var(--vscode-textCodeBlock-background); }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid transparent; padding: 7px 12px; margin: 4px; cursor: pointer; }
button[aria-pressed="true"] { outline: 2px solid var(--vscode-focusBorder); }
button:disabled { opacity: .5; cursor: default; }
.removed { border-left: 3px solid var(--vscode-gitDecoration-deletedResourceForeground); }
.added { border-left: 3px solid var(--vscode-gitDecoration-addedResourceForeground); }
#status { padding: 12px 0; }
</style></head><body>
<h1>Review proposed changes</h1><h2 id="path"></h2><p id="rationale"></p>
<p>Review each change independently. Apply affects the editor buffer. Save and Undo remain under your control.</p>
<div id="hunks"></div><button id="apply" disabled>Apply accepted hunks</button><button id="discard">Discard proposal</button>
<button id="undo" disabled>Undo applied hunks</button>
<p id="status" role="status" aria-live="polite">Loading proposal…</p>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const decisions = new Map();
let ids = [];
let state = 'pending';
const apply = document.getElementById('apply');
function update() {
  apply.disabled = state !== 'pending' || decisions.size !== ids.length || ids.length === 0;
  document.getElementById('discard').disabled = state !== 'pending';
  document.getElementById('undo').disabled = state !== 'applied';
  document.querySelectorAll('[data-decision]').forEach(button => { button.disabled = state !== 'pending'; });
}
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'review') {
    decisions.clear();
    ids = message.hunks.map(hunk => hunk.id);
    document.getElementById('path').textContent = message.path;
    document.getElementById('rationale').textContent = message.rationale;
    document.getElementById('hunks').replaceChildren();
    message.hunks.forEach((hunk, index) => {
      const article = document.createElement('article');
      const heading = document.createElement('h3');
      heading.textContent = hunk.path + ' · hunk ' + (index + 1) + ' · original line ' + hunk.startLine;
      article.append(heading);
      [['Original', hunk.oldText, 'removed'], ['Proposed', hunk.newText, 'added']].forEach(([label, text, kind]) => {
        const title = document.createElement('strong'); title.textContent = label;
        const code = document.createElement('pre'); code.textContent = text || '(empty)'; code.className = kind;
        article.append(title, code);
      });
      ['accept', 'reject'].forEach(decision => {
        const button = document.createElement('button');
        button.textContent = decision === 'accept' ? 'Accept' : 'Reject';
        button.dataset.decision = decision; button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => {
          if (state !== 'pending') return;
          decisions.set(hunk.id, decision);
          article.querySelectorAll('button').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
          vscode.postMessage({ type: 'decision', id: hunk.id, decision }); update();
        });
        article.append(button);
      });
      document.getElementById('hunks').append(article);
    });
  } else if (message.type === 'status') {
    state = message.status;
    document.getElementById('status').textContent = message.message;
  }
  update();
});
apply.addEventListener('click', () => {
  if (state !== 'pending' || apply.disabled) return;
  state = 'applying'; update(); vscode.postMessage({ type: 'apply' });
});
document.getElementById('discard').addEventListener('click', () => vscode.postMessage({ type: 'discard' }));
document.getElementById('undo').addEventListener('click', () => { state = 'undoing'; update(); vscode.postMessage({ type: 'undo' }); });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
