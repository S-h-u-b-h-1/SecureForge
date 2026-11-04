import { Workspace, redactSecrets } from '../src/workspace.mjs';
import { createTrueForgeClient } from '../src/agent.mjs';
import { LiveRun, localTrueForgeUrl } from '../src/live-run.mjs';
import { runApprovedCommand } from '../src/commands.mjs';
import { openReviewPayload } from './review-ui.mjs';
import { createPassport } from '../src/passport.mjs';
import { registerSecurityCommands } from './security-ui.mjs';

export function registerWorkflows(vscode, context) {
  const output = vscode.window.createOutputChannel('SecureForge Activity');
  const receipts = [];
  const applied = [];
  const securityReports = [];
  const proofs = [];
  let activeRun;
  context.subscriptions.push(output, { dispose: () => { void activeRun?.cancel(); } });

  async function folder() {
    if (!vscode.workspace.isTrusted) throw new Error('A trusted local workspace is required');
    const folders = vscode.workspace.workspaceFolders?.filter(item => item.uri.scheme === 'file');
    if (!folders?.length) throw new Error('Open a local workspace first');
    if (folders.length === 1) return folders[0];
    return (await vscode.window.showQuickPick(folders.map(item => ({ label: item.name, folder: item })),
      { title: 'Choose the workspace' }))?.folder;
  }

  function recordReview(record) {
    applied.push({ ...record, recordedAt: new Date().toISOString(), group: {
      id: record.group.id,
      files: record.group.files.map(file => ({
        id: file.id, path: file.path, baseSha256: file.baseSha256,
        hunks: file.hunks.map(hunk => ({ id: hunk.id, startLine: hunk.startLine })),
      })),
    } });
    if (applied.length > 100) applied.shift();
  }

  async function build(initialTask) {
    if (activeRun) throw new Error('Cancel or finish the current agent run first');
    const selected = await folder();
    if (!selected) return;
    const task = typeof initialTask === 'string' ? initialTask : await vscode.window.showInputBox({ title: 'SecureForge Build', prompt: 'Describe the repository change' });
    if (!task?.trim()) return;
    const settings = vscode.workspace.getConfiguration('secureforge');
    const baseUrl = localTrueForgeUrl(settings.get('trueforgeUrl', 'http://localhost:8790'));
    const model = settings.get('model', '').trim() || await vscode.window.showInputBox({
      title: 'TrueForge model', prompt: 'Enter the configured model FQN from TrueForge Settings → Models',
    });
    if (!model?.trim()) return;
    const client = await createTrueForgeClient({ baseUrl });
    let outputBytes = 0;
    output.clear();
    output.show(true);
    output.appendLine(`TrueForge ${baseUrl} | Build | ${model}`);
    activeRun = new LiveRun({
      client, root: selected.uri.fsPath,
      verifyCommand: (workspace, request, signal) => runCheck(workspace, request, signal),
      onEvent(event) {
        if (outputBytes > 64 * 1024) return;
        const line = redactSecrets(event.content || event.type);
        outputBytes += Buffer.byteLength(line);
        output.appendLine(line.slice(0, 4000));
      },
      approveTool: async ({ sessionId }) => await vscode.window.showWarningMessage(
        'Allow this TrueForge workspace-tool request?', { modal: true,
          detail: `Session ${sessionId}. This permits local tool validation. Applying edits and executing commands require their separate local approvals.` },
        'Allow request'
      ) === 'Allow request',
    });
    const run = activeRun;
    try {
      const payload = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'SecureForge Build', cancellable: true,
      }, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => { void run.cancel(); });
        try { return await run.run({ model: model.trim(), task }); }
        finally { subscription.dispose(); }
      });
      if (!payload.proposals.length) {
        vscode.window.showInformationMessage(`TrueForge session ${payload.sessionId} finished without an edit proposal.`);
        return;
      }
      const workspace = await new Workspace(selected.uri.fsPath).init();
      try {
        await openReviewPayload(vscode, context, workspace, payload, record => {
          recordReview({ ...record, sessionId: payload.sessionId });
        });
      } catch (error) { await workspace.close(); throw error; }
    } finally {
      activeRun = undefined;
    }
  }

  async function verify() {
    const selected = await folder();
    if (!selected) return;
    const choice = await vscode.window.showQuickPick(['Node test', 'Python pytest'], { title: 'Verification runner' });
    if (!choice) return;
    const file = await vscode.window.showInputBox({ title: 'Verification test file', prompt: 'Workspace-relative test file path' });
    if (!file) return;
    const request = choice === 'Node test'
      ? { executable: 'node', args: ['--test', file] }
      : { executable: 'python3', args: ['-m', 'pytest', file, '-q'] };
    const workspace = await new Workspace(selected.uri.fsPath).init();
    try { return await runCheck(workspace, request); }
    finally { await workspace.close(); }
  }

  async function runCheck(workspace, request, parentSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    if (parentSignal?.aborted) controller.abort();
    try {
      const receipt = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'SecureForge verification', cancellable: true,
      }, async (_progress, token) => {
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          return await runApprovedCommand({ workspace, request, signal: controller.signal,
            approve: async command => await vscode.window.showWarningMessage(
              'Run this verification command?', { modal: true, detail:
                `${command.executable} ${command.args.join(' ')}\nWorking directory: ${command.cwd}\nTimeout: ${command.timeoutMs} ms\nTests execute repository code with your local user permissions. Save accepted edits before verifying them.` },
              'Run verification'
            ) === 'Run verification',
          });
        } finally { subscription.dispose(); }
      });
      receipts.push(receipt);
      if (receipts.length > 100) receipts.shift();
      output.appendLine(`Verification ${receipt.status}\n${receipt.output}`);
      output.show(true);
      return receipt;
    } finally { parentSignal?.removeEventListener('abort', abort); }
  }

  async function exportPassport() {
    const passport = createPassport({ reviews: applied, receipts, securityReports, proofs });
    const uri = await vscode.window.showSaveDialog({ title: 'Export Patch Passport',
      defaultUri: vscode.workspace.workspaceFolders?.[0]
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, `SecureForge-Patch-Passport-${passport.id}.json`)
        : undefined,
      filters: { 'Patch Passport JSON': ['json'] } });
    if (!uri) return;
    if (uri.scheme !== 'file') throw new Error('Choose a local export file');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(passport, null, 2)));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  }

  const handlers = {
    'secureforge.runBuild': build,
    'secureforge.cancelRun': () => activeRun?.cancel(),
    'secureforge.runVerification': verify,
    'secureforge.exportPassport': exportPassport,
  };
  for (const [name, handler] of Object.entries(handlers)) {
    context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
      try { return await handler(...args); }
      catch (error) { vscode.window.showErrorMessage(`SecureForge: ${redactSecrets(error.message)}`); }
    }));
  }
  const state = { folder, receipts, applied, securityReports, proofs, output, runCheck, recordReview };
  registerSecurityCommands(vscode, context, state);
  return state;
}
