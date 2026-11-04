import { Workspace, redactSecrets } from '../src/workspace.mjs';
import { createTrueForgeClient } from '../src/agent.mjs';
import { LiveRun, localTrueForgeUrl } from '../src/live-run.mjs';
import { runApprovedCommand } from '../src/commands.mjs';
import { openReviewPayload } from './review-ui.mjs';

export function registerWorkflows(vscode, context) {
  const output = vscode.window.createOutputChannel('SecureForge Activity');
  const receipts = [];
  const applied = [];
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

  async function build() {
    if (activeRun) throw new Error('Cancel or finish the current agent run first');
    const selected = await folder();
    if (!selected) return;
    const task = await vscode.window.showInputBox({ title: 'SecureForge Build', prompt: 'Describe the repository change' });
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
      onEvent(event) {
        if (outputBytes > 64 * 1024) return;
        const line = redactSecrets(event.content || event.type);
        outputBytes += Buffer.byteLength(line);
        output.appendLine(line.slice(0, 4000));
      },
      approveTool: async ({ sessionId }) => await vscode.window.showWarningMessage(
        'Allow TrueForge to stage an in-memory proposal?', { modal: true,
          detail: `Session ${sessionId}. Source changes still require separate per-hunk review.` },
        'Allow staging'
      ) === 'Allow staging',
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
          applied.push({ ...record, sessionId: payload.sessionId });
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
    const controller = new AbortController();
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
      output.appendLine(`Verification ${receipt.status}\n${receipt.output}`);
      output.show(true);
    } finally { await workspace.close(); }
  }

  const handlers = {
    'secureforge.runBuild': build,
    'secureforge.cancelRun': () => activeRun?.cancel(),
    'secureforge.runVerification': verify,
  };
  for (const [name, handler] of Object.entries(handlers)) {
    context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
      try { await handler(); }
      catch (error) { vscode.window.showErrorMessage(`SecureForge: ${redactSecrets(error.message)}`); }
    }));
  }
  return { folder, receipts, applied, output };
}
