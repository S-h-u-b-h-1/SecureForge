import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { Workspace, sha256 } from '../src/workspace.mjs';
import { ProposalStore } from '../src/proposals.mjs';
import { openReviewPayload, recheckReviewEntries } from '../extension/review-ui.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sf-review-recheck-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'sample.py');
  const original = 'first\nunchanged\nlast\n';
  const proposed = 'FIRST\nunchanged\nLAST\n';
  await writeFile(filename, original);
  const workspace = await new Workspace(root).init();
  t.after(() => workspace.close());
  return { root, filename, original, proposed, workspace };
}

test('recheck refreshes only clean, byte-identical review buffers; preserves hash-based protection', async t => {
  const f = await fixture(t);
  let currentText = f.original;
  const doc = { uri: { scheme: 'file', fsPath: f.filename }, isClosed: false,
    isDirty: false, version: 5, getText: () => currentText };
  const entry = { document: doc, review: { path: 'sample.py', baseSha256: sha256(f.original) },
    baseVersion: 1 };
  assert.equal(await recheckReviewEntries({
    vscode: { workspace: { isTrusted: true } }, workspace: f.workspace, entries: [entry],
  }), 1);
  assert.equal(entry.baseVersion, 5);
  doc.isDirty = true;
  doc.version++;
  await assert.rejects(recheckReviewEntries({
    vscode: { workspace: { isTrusted: true } }, workspace: f.workspace, entries: [entry],
  }), /unsaved changes/);
  assert.equal(entry.baseVersion, 5, 'Unsaved edits must not rebase a review');
  doc.isDirty = false;
  currentText = 'other content\n';
  doc.version++;
  await assert.rejects(recheckReviewEntries({
    vscode: { workspace: { isTrusted: true } }, workspace: f.workspace, entries: [entry],
  }), /changed since proposal/);
  assert.equal(entry.baseVersion, 5);
  currentText = f.original;
  await writeFile(f.filename, 'changed on disk\n');
  await assert.rejects(recheckReviewEntries({
    vscode: { workspace: { isTrusted: true } }, workspace: f.workspace, entries: [entry],
  }), /changed since proposal/);
  assert.equal(entry.baseVersion, 5);
  await assert.rejects(recheckReviewEntries({
    vscode: { workspace: { isTrusted: false } }, workspace: f.workspace, entries: [entry],
  }), /trusted workspace/);
});

test('a stale file prevents the entire multi-file version refresh', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'other.py'), 'second\n');
  const a = { document: {
    uri: { scheme: 'file', fsPath: f.filename }, isClosed: false, isDirty: false,
    version: 8, getText: () => f.original,
  }, review: { path: 'sample.py', baseSha256: sha256(f.original) }, baseVersion: 1 };
  const b = { document: {
    uri: { scheme: 'file', fsPath: path.join(f.root, 'other.py') }, isClosed: false,
    isDirty: true, version: 3, getText: () => 'second\n',
  }, review: { path: 'other.py', baseSha256: sha256('second\n') }, baseVersion: 1 };
  await assert.rejects(recheckReviewEntries({
    vscode: { workspace: { isTrusted: true } }, workspace: f.workspace, entries: [a, b],
  }), /unsaved changes/);
  assert.equal(a.baseVersion, 1, 'No partial version refresh is allowed');
  assert.equal(b.baseVersion, 1);
});

async function openMockPanel(t) {
  const f = await fixture(t);
  const store = new ProposalStore(f.workspace);
  const pending = await store.proposeEdit({
    path: 'sample.py', expectedSha256: sha256(f.original), proposedContent: f.proposed,
  });
  const proposal = store.getProposal(pending.id);
  let text = f.original;
  const document = { uri: { scheme: 'file', fsPath: f.filename }, version: 1,
    isDirty: false, isClosed: false, getText: () => text, positionAt: offset => offset };
  const events = [];
  let receive;
  let onChange;
  const applied = [];
  const panel = {
    webview: {
      postMessage(message) { events.push(message); },
      onDidReceiveMessage(handler) { receive = handler; return { dispose() {} }; },
    },
    onDidDispose() { return { dispose() {} }; },
  };
  class Range { constructor(start, end) { this.start = start; this.end = end; } }
  class WorkspaceEdit {
    constructor() { this.edits = []; }
    replace(uri, range, newText) { this.edits.push({ uri, range, newText }); }
  }
  const vscode = {
    ViewColumn: { One: 1, Beside: 2 }, Range, WorkspaceEdit,
    Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
    workspace: {
      isTrusted: true,
      openTextDocument: async () => document,
      onDidChangeTextDocument: handler => { onChange = handler; return { dispose() {} }; },
      applyEdit: async edit => {
        for (const e of edit.edits.sort((a, b) => b.range.start - a.range.start)) {
          text = text.slice(0, e.range.start) + e.newText + text.slice(e.range.end);
        }
        document.version++;
        document.isDirty = true;
        onChange?.({ document });
        return true;
      },
    },
    window: {
      showTextDocument: async () => {},
      createWebviewPanel: () => panel,
    },
  };
  const context = { subscriptions: [] };
  await openReviewPayload(vscode, context, f.workspace, proposal,
    result => applied.push(result));
  return { ...f, events, applied, panel, receive: value => receive(value),
    document, onChange: () => onChange?.({ document }), text: () => text,
    changeVersion: () => { document.version++; onChange?.({ document }); } };
}

test('accept all marks decisions but never writes; stale review rechecks before a separate apply', async t => {
  const f = await openMockPanel(t);
  await f.receive({ type: 'ready' });
  const review = f.events.find(event => event.type === 'review');
  assert.equal(review.hunks.length, 2);
  await f.receive({ type: 'acceptAll' });
  assert.match(f.events.at(-1).message, /Marked all 2 hunks Accept/);
  assert.equal(f.text(), f.original);
  assert.equal(await readFile(f.filename, 'utf8'), f.original);
  f.changeVersion();
  assert.equal(f.events.at(-1).status, 'stale');
  await f.receive({ type: 'apply' });
  assert.equal(f.text(), f.original, 'Stale version must not write to an editor buffer');
  await f.receive({ type: 'recheck' });
  assert.equal(f.events.at(-1).status, 'pending');
  await f.receive({ type: 'apply' });
  assert.equal(f.text(), f.proposed);
  assert.equal(f.applied.length, 1);
  assert.equal(f.applied[0].result.status, 'applied');
  assert.equal(f.applied[0].result.accepted, 2);
  assert.equal(await readFile(f.filename, 'utf8'), f.original,
    'Even accepted hunks must not write to disk until VS Code Save');
});

test('recheck cannot recover or apply when the editor has unsaved modifications', async t => {
  const f = await openMockPanel(t);
  await f.receive({ type: 'ready' });
  await f.receive({ type: 'acceptAll' });
  f.document.isDirty = true;
  f.changeVersion();
  await f.receive({ type: 'recheck' });
  assert.equal(f.events.at(-1).status, 'blocked');
  assert.match(f.events.at(-1).message, /unsaved changes/);
  await f.receive({ type: 'apply' });
  assert.equal(f.text(), f.original);
  assert.equal(f.applied.length, 0);
  assert.equal(await readFile(f.filename, 'utf8'), f.original);
});

test('review webview exposes separate Accept all, Apply, and stale Recheck controls', async t => {
  const f = await openMockPanel(t);
  const script = f.panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.match(f.panel.webview.html, /id="acceptAll"/);
  assert.match(f.panel.webview.html, /id="recheck"/);
  const nodes = new Map();
  const all = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {};
      this.disabled = false; this.hidden = false; this.attrs = {}; this.handlers = {}; all.push(this); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    setAttribute(name, value) { this.attrs[name] = value; }
    querySelectorAll(selector) {
      const descendants = [];
      const visit = item => { for (const c of item.children) {
        if (selector === 'button' && c.tag === 'button') descendants.push(c);
        visit(c);
      } };
      visit(this); return descendants;
    }
  }
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Element('div'));
    return nodes.get(id);
  };
  const posted = [];
  const listeners = {};
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: msg => posted.push(msg) }),
    document: {
      getElementById: get,
      createElement: name => new Element(name),
      querySelectorAll: selector => selector === '[data-decision]'
        ? all.filter(el => el.dataset.decision) : [],
    },
    window: { addEventListener: (event, fn) => { listeners[event] = fn; } },
  });
  assert.equal(posted[0].type, 'ready');
  listeners.message({ data: { type: 'review', path: 'sample.py', rationale: 'Test',
    hunks: [
      { id: 'one', path: 'sample.py', startLine: 1, oldText: 'first', newText: 'FIRST' },
      { id: 'two', path: 'sample.py', startLine: 3, oldText: 'last', newText: 'LAST' },
    ],
  } });
  assert.equal(get('apply').disabled, true);
  get('acceptAll').handlers.click();
  assert.equal(posted.at(-1).type, 'acceptAll');
  assert.equal(get('apply').disabled, false);
  assert.equal(all.filter(el => el.dataset.decision === 'accept')
    .every(el => el.attrs['aria-pressed'] === 'true'), true);
  assert.equal(all.filter(el => el.dataset.decision === 'reject')
    .every(el => el.attrs['aria-pressed'] === 'false'), true);
  // Accept All must not apply by itself.
  assert.equal(posted.filter(x => x.type === 'apply').length, 0);
  listeners.message({ data: { type: 'status', status: 'stale', message: 'Version changed' } });
  assert.equal(get('apply').disabled, true);
  assert.equal(get('recheck').hidden, false);
  get('recheck').handlers.click();
  assert.equal(posted.at(-1).type, 'recheck');
  listeners.message({ data: { type: 'status', status: 'pending', message: 'Clean buffers match' } });
  assert.equal(get('recheck').hidden, true);
  assert.equal(get('apply').disabled, false);
  get('apply').handlers.click();
  assert.equal(posted.at(-1).type, 'apply');
});
