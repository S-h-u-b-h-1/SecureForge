import path from 'node:path';
import { composeAcceptedHunks } from '../src/review.mjs';
import { sha256 } from '../src/workspace.mjs';

export async function applyReview({ vscode, workspace, document, review, decisions, baseVersion }) {
  const result = await applyReviewGroup({
    vscode, workspace, entries: [{ document, review, baseVersion }], decisions,
  });
  return { status: result.status, accepted: result.accepted };
}

const activeRoots = new Set();

export async function applyReviewGroup({ vscode, workspace, entries, decisions, signal }) {
  if (!vscode.workspace.isTrusted) throw new Error('A trusted workspace is required');
  if (activeRoots.has(workspace.root)) throw new Error('Another review is being applied to this workspace');
  activeRoots.add(workspace.root);
  try {
    signal?.throwIfAborted();
    const prepared = [];
    for (const entry of entries) {
      prepared.push(await prepareFile(workspace, entry, decisions));
      signal?.throwIfAborted();
    }
    // Check every editor version again after all asynchronous filesystem reads.
    for (const { document, baseVersion } of entries) {
      if (document.isClosed || document.isDirty || document.version !== baseVersion) {
        throw new Error('Stale proposal: one of the reviewed documents changed');
      }
    }
    const count = prepared.reduce((total, file) => total + file.result.accepted.length, 0);
    if (count === 0) return { status: 'rejected', accepted: 0, files: [] };
    const edit = new vscode.WorkspaceEdit();
    for (const { document, result } of prepared) {
      for (const hunk of result.accepted) {
        edit.replace(document.uri, new vscode.Range(
          document.positionAt(hunk.startOffset), document.positionAt(hunk.endOffset)
        ), hunk.newText);
      }
    }
    signal?.throwIfAborted();
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code declined the edit');
    for (const { document, result } of prepared) {
      if (document.getText() !== result.content) {
        throw new Error('Document changed during apply. Inspect the editor and use Undo before continuing.');
      }
    }
    // Keep edits in the editor buffer. The developer controls Save and native Undo.
    return {
      status: 'applied', accepted: count,
      files: prepared.map(({ document, review, result }) => ({
        path: review.path, beforeSha256: review.baseSha256, afterSha256: sha256(result.content),
        documentVersion: document.version, acceptedHunkIds: result.accepted.map(hunk => hunk.id),
      })),
    };
  } finally {
    activeRoots.delete(workspace.root);
  }
}

async function prepareFile(workspace, { document, review, baseVersion }, decisions) {
  if (document.isClosed || document.isDirty || document.version !== baseVersion) {
    throw new Error('Stale proposal: document version changed or has unsaved edits');
  }
  const current = await workspace.rawForProposal(review.path);
  if (current.hash !== review.baseSha256 || document.uri.scheme !== 'file' ||
      document.uri.fsPath !== path.resolve(workspace.root, review.path)) {
    throw new Error('Stale proposal or mismatched workspace document');
  }
  // Recheck the open document after the asynchronous disk read. Never overwrite
  // edits that arrived while the user was reviewing or validation was running.
  const text = document.getText();
  if (document.version !== baseVersion || document.isDirty || sha256(text) !== review.baseSha256) {
    throw new Error('Stale proposal: document content changed');
  }
  const ownDecisions = Object.fromEntries(review.hunks.map(hunk => [hunk.id, decisions[hunk.id]]));
  const result = composeAcceptedHunks(review, ownDecisions, text);
  return { document, review, result };
}

export async function undoReviewGroup({ vscode, workspace, entries, receipt }) {
  if (!vscode.workspace.isTrusted || receipt.status !== 'applied') throw new Error('An applied review is required');
  if (activeRoots.has(workspace.root)) throw new Error('Another review is being applied');
  activeRoots.add(workspace.root);
  try {
    const changed = entries.filter(entry => receipt.files.some(file => file.path === entry.review.path && file.acceptedHunkIds.length));
    for (const { document, review } of changed) {
      const record = receipt.files.find(file => file.path === review.path);
      const disk = await workspace.rawForProposal(review.path);
      if (document.isClosed || document.version !== record.documentVersion ||
          sha256(document.getText()) !== record.afterSha256 ||
          ![record.beforeSha256, record.afterSha256].includes(disk.hash)) {
        throw new Error('Cannot undo review after another document or disk change');
      }
    }
    const edit = new vscode.WorkspaceEdit();
    for (const { document, review } of changed) {
      const record = receipt.files.find(file => file.path === review.path);
      if (document.isClosed || document.version !== record.documentVersion) throw new Error('Document changed while preparing Undo');
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), review.originalContent);
    }
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code declined Undo');
    if (changed.some(entry => entry.document.getText() !== entry.review.originalContent)) {
      throw new Error('Document changed during Undo. Inspect the source editor before continuing.');
    }
    return { status: 'undone', files: changed.map(entry => entry.review.path) };
  } finally { activeRoots.delete(workspace.root); }
}
