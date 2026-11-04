const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vscode = require('vscode');

async function undoAndWait(document, expected) {
  await vscode.window.showTextDocument(document, { preview: false });
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  const restored = new Promise((resolve, reject) => {
    const subscription = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document === document && document.getText() === expected) {
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error('Native Undo did not restore the expected document within 10 seconds'));
    }, 10000);
  });
  await vscode.commands.executeCommand('undo');
  await restored;
}

exports.run = async function run() {
  const results = [];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secureforge-editor-'));
  const { Workspace, sha256 } = await import('../../src/workspace.mjs');
  const { ProposalStore } = await import('../../src/proposals.mjs');
  const { createReview } = await import('../../src/review.mjs');
  const { applyReview } = await import('../../extension/apply-review.mjs');
  const workspace = await new Workspace(root).init();
  const original = 'first\nunchanged\nlast\n';
  const proposed = 'FIRST\nunchanged\nLAST\n';
  const filename = path.join(workspace.root, 'sample.py');
  try {
    const extension = vscode.extensions.getExtension('secureforge.secureforge-review');
    assert.ok(extension, 'Review extension is installed in the development host');
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('secureforge.reviewProposal'));
    assert.ok(commands.includes('secureforge.reviewDemo'));
    results.push('Extension activation and command registration');

    await fs.writeFile(filename, original);
    const store = new ProposalStore(workspace);
    const summary = await store.proposeEdit({
      path: 'sample.py', expectedSha256: sha256(original), proposedContent: proposed,
    });
    const review = createReview(store.getProposal(summary.id));
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
    await vscode.window.showTextDocument(document);
    const baseVersion = document.version;
    const decisions = { [review.hunks[0].id]: 'accept', [review.hunks[1].id]: 'reject' };
    const inputs = { vscode, workspace, document, review, decisions, baseVersion };
    assert.equal((await applyReview(inputs)).status, 'applied');
    assert.equal(document.getText(), 'FIRST\nunchanged\nlast\n');
    assert.equal(await fs.readFile(filename, 'utf8'), original);
    results.push('Mixed hunk decisions apply only the accepted edit in the editor');

    await assert.rejects(applyReview(inputs), /Stale/);
    results.push('Repeated application is rejected');
    await undoAndWait(document, original);
    assert.equal(document.getText(), original);
    results.push('Native VS Code Undo restores the original content');
    await document.save();

    await assert.rejects(applyReview(inputs), /Stale/);
    results.push('Changed document version is rejected even after Undo');
    const freshInputs = { ...inputs, baseVersion: document.version };
    freshInputs.decisions = Object.fromEntries(review.hunks.map(hunk => [hunk.id, 'reject']));
    assert.equal((await applyReview(freshInputs)).status, 'rejected');
    assert.equal(document.getText(), original);
    results.push('Rejecting all hunks preserves content');

    await fs.writeFile(filename, 'external disk edit\n');
    await assert.rejects(applyReview(freshInputs), /Stale/);
    assert.equal(await fs.readFile(filename, 'utf8'), 'external disk edit\n');
    results.push('External disk changes are preserved');

    const unicodeOriginal = '😀 café\r\nkeep\r\nlast';
    const unicodeProposed = '😀 नमस्ते\r\nkeep\r\nLAST';
    const unicodePath = path.join(workspace.root, 'unicode.py');
    await fs.writeFile(unicodePath, unicodeOriginal);
    const unicodeSummary = await store.proposeEdit({
      path: 'unicode.py', expectedSha256: sha256(unicodeOriginal), proposedContent: unicodeProposed,
    });
    const unicodeReview = createReview(store.getProposal(unicodeSummary.id));
    const unicodeDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(unicodePath));
    await vscode.window.showTextDocument(unicodeDocument);
    await applyReview({
      vscode, workspace, document: unicodeDocument, review: unicodeReview,
      baseVersion: unicodeDocument.version,
      decisions: Object.fromEntries(unicodeReview.hunks.map(hunk => [hunk.id, 'accept'])),
    });
    assert.equal(unicodeDocument.getText(), unicodeProposed);
    await undoAndWait(unicodeDocument, unicodeOriginal);
    assert.equal(unicodeDocument.getText(), unicodeOriginal);
    results.push('Unicode, CRLF and missing final newline survive editor apply and Undo');
    if (process.env.SECUREFORGE_EDITOR_REPORT) {
      await fs.writeFile(process.env.SECUREFORGE_EDITOR_REPORT, JSON.stringify({ passed: results }, null, 2));
    }
    console.log('SecureForge editor checks passed:', results);
  } catch (error) {
    if (process.env.SECUREFORGE_EDITOR_REPORT) {
      await fs.writeFile(process.env.SECUREFORGE_EDITOR_REPORT, JSON.stringify({ passed: results, error: error.stack }, null, 2));
    }
    throw error;
  } finally {
    await workspace.close();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await fs.rm(root, { recursive: true, force: true });
  }
};
