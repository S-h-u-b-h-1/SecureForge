import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { Workspace } from '../src/workspace.mjs';
import { ProposalStore } from '../src/proposals.mjs';
import { registerInlineReview } from '../extension/inline-review.mjs';

async function harness(t, proposed = 'HELLO\nkeep\nBYE\n') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-inline-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await new Workspace(root).init();
  const original = 'hello\nkeep\nbye\n';
  const file = path.join(workspace.root, 'sample.py');
  await writeFile(file, original);
  const store = new ProposalStore(workspace);
  const base = await workspace.rawForProposal('sample.py');
  const summary = await store.proposeEdit({
    path: 'sample.py', expectedSha256: base.hash, proposedContent: proposed,
    rationale: 'Test inline editor review',
  });
  const payload = store.getProposal(summary.id);
  const handlers = new Map();
  const events = [];
  const notice = [];
  let provider;
  let changedHandler;
  let docText = original;
  const disposable = () => ({ dispose() {} });
  const pos = offset => {
    const before = docText.slice(0, offset);
    const line = before.split('\n').length - 1;
    return { line, character: before.length - before.lastIndexOf('\n') - 1 };
  };
  const offset = point => {
    const lines = docText.split('\n');
    return lines.slice(0, point.line).reduce((sum, text) => sum + text.length + 1, 0) + point.character;
  };
  const document = {
    uri: { scheme: 'file', fsPath: file }, version: 1, isDirty: false, isClosed: false,
    languageId: 'python', getText: () => docText, positionAt: pos, offsetAt: offset,
    get lineCount() { return docText.split('\n').length; },
    lineAt: line => ({ text: docText.split('\n')[line] ?? '' }),
  };
  class EventEmitter { constructor() { this.event = () => disposable(); } fire() {} dispose() {} }
  class Range {
    constructor(a, b, c, d) {
      if (typeof a === 'object') { this.start = a; this.end = b; }
      else { this.start = { line: a, character: b }; this.end = { line: c, character: d }; }
    }
  }
  class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
  class ThemeColor { constructor(name) { this.name = name; } }
  class MarkdownString {
    appendMarkdown() { return this; }
    appendCodeblock() { return this; }
  }
  class WorkspaceEdit {
    constructor() { this.edits = []; }
    replace(uri, range, newText) { this.edits.push({ uri, range, newText }); }
  }
  const editor = { document, setDecorations() {}, revealRange() {} };
  const vscode = {
    EventEmitter, Range, CodeLens, ThemeColor, MarkdownString, WorkspaceEdit,
    TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    ViewColumn: { Active: 1 }, Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
    commands: {
      registerCommand: (name, fn) => { handlers.set(name, fn); return disposable(); },
    },
    languages: {
      registerCodeLensProvider: (_selector, value) => { provider = value; return disposable(); },
    },
    workspace: {
      isTrusted: true, openTextDocument: async () => document,
      onDidChangeTextDocument: handler => { changedHandler = handler; return disposable(); },
      applyEdit: async edit => {
        const offsets = edit.edits.map(item => ({
          from: offset(item.range.start), to: offset(item.range.end), text: item.newText,
        })).sort((a, b) => b.from - a.from);
        for (const item of offsets) docText = docText.slice(0, item.from) + item.text + docText.slice(item.to);
        document.version++;
        document.isDirty = true;
        changedHandler?.({ document });
        return true;
      },
    },
    window: {
      visibleTextEditors: [editor], activeTextEditor: editor,
      createTextEditorDecorationType: () => ({ dispose() {} }),
      onDidChangeVisibleTextEditors: () => disposable(),
      showTextDocument: async () => editor,
      showWarningMessage: message => notice.push(message),
    },
  };
  const context = { subscriptions: [] };
  const controller = registerInlineReview(vscode, context, {
    notify: event => events.push(event),
    onApplied: event => events.push({ type: 'receipt', ...event }),
  });
  t.after(() => controller.dispose());
  await controller.open(workspace, payload);
  return {
    root, file, original, document, controller, provider, handlers, events, notice,
    text: () => docText, get hunks() { return payload.proposals?.[0]?.hunks; },
  };
}

test('native CodeLens review accepts one hunk and rejects another without a separate panel', async t => {
  const fixture = await harness(t);
  const { controller, provider, document, events, original, file } = fixture;
  const lenses = provider.provideCodeLenses(document);
  assert.ok(lenses.some(item => item.command.command === 'secureforge.inlineReview.accept'));
  assert.ok(lenses.some(item => item.command.command === 'secureforge.inlineReview.reject'));
  assert.equal(await readFile(file, 'utf8'), original, 'Staging must not edit source');
  const state = events.find(item => item.type === 'inlineReviewState' && item.status === 'pending');
  assert.equal(state.hunks.length, 2);
  await controller.action('accept', state.hunks[0].id);
  await controller.action('reject', state.hunks[1].id);
  const approval = provider.provideCodeLenses(document);
  assert.ok(approval.some(item => item.command.command === 'secureforge.inlineReview.apply'));
  assert.equal(await readFile(file, 'utf8'), original, 'Hunk selection alone must not change disk');
  await controller.action('apply');
  assert.equal(controller.status, 'applied');
  assert.equal(fixture.text(), 'HELLO\nkeep\nbye\n');
  assert.equal(await readFile(file, 'utf8'), original, 'Apply stays in the editor until Save');
  await controller.action('undo');
  assert.equal(controller.status, 'undone');
  assert.equal(fixture.text(), original);
});

test('source changed on disk blocks inline apply instead of overwriting it', async t => {
  const fixture = await harness(t);
  const initial = fixture.events.find(item => item.type === 'inlineReviewState');
  for (const item of initial.hunks) await fixture.controller.action('accept', item.id);
  await writeFile(fixture.file, 'externally modified\n');
  await fixture.controller.action('apply');
  assert.equal(fixture.controller.status, 'blocked');
  assert.equal(fixture.text(), fixture.original);
  assert.equal(await readFile(fixture.file, 'utf8'), 'externally modified\n');
  assert.match(fixture.events.at(-1).message, /Stale proposal/);
});

test('unknown hunk IDs and unapproved apply are refused', async t => {
  const fixture = await harness(t);
  await assert.rejects(fixture.controller.action('accept', 'not-a-hunk'), /Unknown review hunk/);
  await assert.rejects(fixture.controller.action('apply'), /Accept or reject every hunk/);
  assert.equal(fixture.text(), fixture.original);
});
