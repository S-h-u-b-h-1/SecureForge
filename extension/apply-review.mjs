import path from 'node:path';
import { composeAcceptedHunks } from '../src/review.mjs';
import { sha256 } from '../src/workspace.mjs';

export async function applyReview({ vscode, workspace, document, review, decisions, baseVersion }) {
  if (!vscode.workspace.isTrusted) throw new Error('A trusted workspace is required');
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
  const result = composeAcceptedHunks(review, decisions, text);
  if (result.accepted.length === 0) return { status: 'rejected', accepted: 0 };
  const edit = new vscode.WorkspaceEdit();
  for (const hunk of result.accepted) {
    edit.replace(document.uri, new vscode.Range(
      document.positionAt(hunk.startOffset), document.positionAt(hunk.endOffset)
    ), hunk.newText);
  }
  if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code declined the edit');
  if (document.getText() !== result.content) {
    throw new Error('Document changed during apply. Inspect the editor and use Undo before continuing.');
  }
  // Keep edits in the editor buffer. The developer controls Save and native Undo.
  return { status: 'applied', accepted: result.accepted.length };
}
