import path from 'node:path';
import { createReviewGroup } from '../src/review-group.mjs';
import { sha256, redactSecrets } from '../src/workspace.mjs';
import { applyReviewGroup, undoReviewGroup } from './apply-review.mjs';
import { recheckReviewEntries } from './review-ui.mjs';

// Native CodeLens controls sit above the affected source line. Nothing is
// written to an editor buffer until the developer explicitly applies the
// accepted hunks. The existing hash-checked WorkspaceEdit path is reused.
export function registerInlineReview(vscode, context, { onApplied = () => {}, notify = () => {} } = {}) {
  let active;
  const changed = new vscode.EventEmitter();
  const highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
  });
  const ghost = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorGhostText.foreground'),
      margin: '0 0 0 12px',
      fontStyle: 'italic',
    },
  });

  function fileFor(document) {
    return active?.group.files.find(file => path.resolve(active.workspace.root, file.path) === document.uri.fsPath);
  }

  function preview(hunk) {
    const line = hunk.newText.split(/\r?\n/).find(text => text.trim())?.trim() || '(remove lines)';
    return line.length > 96 ? line.slice(0, 93) + '…' : line;
  }

  function safeHover(hunk, language) {
    const hover = new vscode.MarkdownString(undefined, true);
    hover.isTrusted = false;
    hover.appendMarkdown('**SecureForge suggested change**\n\nOriginal:\n\n');
    hover.appendCodeblock(hunk.oldText.slice(0, 1200) || '(empty)', language);
    hover.appendMarkdown('\nProposed:\n\n');
    hover.appendCodeblock(hunk.newText.slice(0, 1200) || '(empty)', language);
    return hover;
  }

  function lenses(document) {
    const file = fileFor(document);
    if (!file) return [];
    const entries = [];
    const canChoose = active.status === 'pending';
    for (const hunk of file.hunks) {
      const line = Math.max(0, Math.min(document.lineCount - 1, hunk.startLine - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const decision = active.decisions[hunk.id];
      if (canChoose) {
        entries.push(new vscode.CodeLens(range, {
          title: decision === 'accept' ? '$(check) Accepted' : '$(check) Accept',
          tooltip: 'Approve this hunk; the file is not edited until Apply',
          command: 'secureforge.inlineReview.accept', arguments: [hunk.id],
        }));
        entries.push(new vscode.CodeLens(range, {
          title: decision === 'reject' ? '$(close) Rejected' : '$(close) Reject',
          tooltip: 'Exclude this hunk from the eventual edit',
          command: 'secureforge.inlineReview.reject', arguments: [hunk.id],
        }));
      }
    }
    if (file === active.group.files[0]) {
      const first = file.hunks[0];
      const line = Math.max(0, Math.min(document.lineCount - 1, first.startLine - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const completed = active.group.files.every(item => item.hunks.every(h => active.decisions[h.id]));
      if (canChoose) {
        if (completed) entries.push(new vscode.CodeLens(range, {
          title: '$(check-all) Apply accepted', tooltip: 'Revalidate every source file and apply the selected hunks',
          command: 'secureforge.inlineReview.apply',
        }));
        entries.push(new vscode.CodeLens(range, {
          title: '$(trash) Discard review', command: 'secureforge.inlineReview.discard',
        }));
      } else if (active.status === 'stale' || active.status === 'blocked') {
        entries.push(new vscode.CodeLens(range, {
          title: '$(refresh) Recheck unchanged files', command: 'secureforge.inlineReview.recheck',
        }));
      } else if (active.status === 'applied') {
        entries.push(new vscode.CodeLens(range, {
          title: '$(discard) Undo approved edit', tooltip: 'Only succeeds when the editor still matches the applied receipt',
          command: 'secureforge.inlineReview.undo',
        }));
      }
    }
    return entries;
  }

  function decorate() {
    for (const editor of vscode.window.visibleTextEditors ?? []) {
      const file = fileFor(editor.document);
      if (!file || !['pending', 'stale', 'blocked'].includes(active.status)) {
        editor.setDecorations(highlight, []);
        editor.setDecorations(ghost, []);
        continue;
      }
      const rows = [];
      const hints = [];
      for (const hunk of file.hunks) {
        const line = Math.max(0, Math.min(editor.document.lineCount - 1, hunk.startLine - 1));
        const end = Math.min(editor.document.lineCount - 1,
          line + Math.max(0, hunk.oldText.split('\n').length - 2));
        rows.push(new vscode.Range(line, 0, end, editor.document.lineAt(end).text.length));
        const right = editor.document.lineAt(line).text.length;
        hints.push({
          range: new vscode.Range(line, right, line, right),
          hoverMessage: safeHover(hunk, editor.document.languageId),
          renderOptions: { after: { contentText: '  ⇢ ' + preview(hunk) } },
        });
      }
      editor.setDecorations(highlight, rows);
      editor.setDecorations(ghost, hints);
    }
  }

  function publish() {
    changed.fire();
    decorate();
    if (!active) return;
    const items = active.group.files.flatMap(file => file.hunks.map(hunk => ({
      id: hunk.id, path: file.path, line: hunk.startLine,
      decision: active.decisions[hunk.id] || null,
      preview: redactSecrets(preview(hunk)).slice(0, 100),
    })));
    notify({
      type: 'inlineReviewState', status: active.status, message: active.message || '',
      hunks: items, accepted: items.filter(item => item.decision === 'accept').length,
      decided: items.filter(item => item.decision).length,
    });
  }

  async function disposeReview() {
    const previous = active;
    active = undefined;
    changed.fire();
    decorate();
    previous?.listener?.dispose();
    if (previous?.workspace) await previous.workspace.close();
  }

  async function open(workspace, payload, reviewCallback = onApplied) {
    if (active && ['pending', 'stale', 'blocked', 'checking', 'applying', 'undoing'].includes(active.status)) {
      throw new Error('Finish or discard the existing inline review before starting another.');
    }
    if (active) await disposeReview();
    const group = createReviewGroup(payload);
    const entries = [];
    for (const review of group.files) {
      const disk = await workspace.rawForProposal(review.path);
      if (disk.hash !== review.baseSha256) throw new Error('Stale proposal: source changed before review');
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.resolve(workspace.root, review.path)));
      if (document.isDirty || sha256(document.getText()) !== review.baseSha256) {
        throw new Error('Save or revert changes in reviewed files before opening this proposal');
      }
      entries.push({ document, review, baseVersion: document.version });
    }
    active = {
      group, entries, workspace, status: 'pending', decisions: Object.create(null),
      callback: reviewCallback, message: 'Review suggested edits above the affected lines or in SecureForge chat.',
    };
    active.listener = vscode.workspace.onDidChangeTextDocument(event => {
      if (active?.status === 'pending' && active.entries.some(entry =>
        entry.document === event.document && event.document.version !== entry.baseVersion)) {
        active.status = 'stale';
        active.message = 'The reviewed document changed. Recheck unchanged files or generate a new proposal.';
        publish();
      }
    });
    const first = entries.find(entry => entry.document === vscode.window.activeTextEditor?.document) || entries[0];
    await vscode.window.showTextDocument(first.document, {
      viewColumn: vscode.ViewColumn.Active, preview: false, preserveFocus: false,
    });
    publish();
    return group;
  }

  async function action(kind, hunkId) {
    const session = active;
    if (!session) throw new Error('No inline review is active');
    if (kind === 'focus') {
      const item = session.group.files.find(file => file.hunks.some(h => h.id === hunkId));
      const entry = session.entries.find(e => e.review === item);
      if (!entry) throw new Error('Unknown review hunk');
      const hunk = item.hunks.find(h => h.id === hunkId);
      const editor = await vscode.window.showTextDocument(entry.document, { preview: false });
      const line = Math.max(0, Math.min(editor.document.lineCount - 1, hunk.startLine - 1));
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    if (kind === 'accept' || kind === 'reject') {
      if (session.status !== 'pending') throw new Error('Review is not ready; recheck unchanged files');
      const exists = session.group.files.some(file => file.hunks.some(hunk => hunk.id === hunkId));
      if (!exists) throw new Error('Unknown review hunk');
      session.decisions[hunkId] = kind;
      session.message = 'Choose each hunk, then Apply accepted in the editor or chat.';
      publish();
      return;
    }
    if (kind === 'discard') {
      if (!['pending', 'stale', 'blocked'].includes(session.status) || session.receipt?.status === 'applied') {
        throw new Error('An applied edit must be undone or left under native editor Undo');
      }
      notify({ type: 'inlineReviewState', status: 'discarded', hunks: [], message: 'Review discarded; no edits applied.' });
      await disposeReview();
      return;
    }
    if (kind === 'recheck') {
      if (!['stale', 'blocked'].includes(session.status) || session.receipt?.status === 'applied') {
        throw new Error('Only an unapplied blocked or stale review can be rechecked');
      }
      session.status = 'checking';
      publish();
      try {
        await recheckReviewEntries({ vscode, workspace: session.workspace, entries: session.entries });
        session.status = 'pending';
        session.message = 'Source and editor match original hashes. Review decisions retained.';
      } catch (error) {
        session.status = 'blocked';
        session.message = redactSecrets(error.message);
      }
      publish();
      return;
    }
    if (kind === 'apply') {
      if (session.status !== 'pending' || session.group.files.some(file =>
        file.hunks.some(hunk => !Object.hasOwn(session.decisions, hunk.id)))) {
        throw new Error('Accept or reject every hunk before applying');
      }
      session.status = 'applying';
      publish();
      try {
        const result = await applyReviewGroup({
          vscode, workspace: session.workspace, entries: session.entries, decisions: session.decisions,
        });
        session.receipt = result;
        session.status = result.status;
        session.message = result.status === 'applied'
          ? 'Applied ' + result.accepted + ' accepted hunk(s) in the editor. Save when ready; Undo is guarded.'
          : 'All hunks rejected. No file was edited.';
        session.callback({ group: session.group, decisions: { ...session.decisions }, result });
      } catch (error) {
        session.status = 'blocked';
        session.message = redactSecrets(error.message);
      }
      publish();
      return;
    }
    if (kind === 'undo') {
      if (session.status !== 'applied' || !session.receipt) throw new Error('No applied review to undo');
      session.status = 'undoing';
      publish();
      try {
        await undoReviewGroup({
          vscode, workspace: session.workspace, entries: session.entries, receipt: session.receipt,
        });
        session.status = 'undone';
        session.message = 'Approved changes undone in the editor.';
        session.callback({
          group: session.group, decisions: { ...session.decisions },
          result: { ...session.receipt, status: 'undone' },
        });
      } catch (error) {
        session.status = 'blocked';
        session.message = redactSecrets(error.message) + '. Native editor Undo remains available.';
      }
      publish();
      return;
    }
    throw new Error('Unsupported inline review action');
  }

  const provider = vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
    onDidChangeCodeLenses: changed.event,
    provideCodeLenses: lenses,
  });
  context.subscriptions.push(provider, changed, highlight, ghost);
  const commands = {
    'secureforge.inlineReview.accept': id => action('accept', id),
    'secureforge.inlineReview.reject': id => action('reject', id),
    'secureforge.inlineReview.apply': () => action('apply'),
    'secureforge.inlineReview.undo': () => action('undo'),
    'secureforge.inlineReview.discard': () => action('discard'),
    'secureforge.inlineReview.recheck': () => action('recheck'),
  };
  for (const [id, run] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
      try { await run(...args); } catch (error) {
        vscode.window.showWarningMessage('SecureForge: ' + redactSecrets(error.message));
      }
    }));
  }
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => decorate()));
  return { open, action, publish, dispose: disposeReview, get status() { return active?.status; } };
}
