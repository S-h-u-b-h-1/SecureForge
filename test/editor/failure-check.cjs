const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

exports.verifyEditorFailure = async function verifyEditorFailure(vscode, api) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder && folder.uri.scheme === 'file');
  const root = folder.uri.fsPath;
  const execute = promisify(execFile);
  const files = ['src/flask/helpers.py', 'src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst'];
  const snapshot = async () => ({
    gitStatus: (await execute('git', ['status', '--porcelain'], { cwd: root })).stdout,
    hashes: Object.fromEntries(await Promise.all(files.map(async file => [file,
      createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')]))),
  });
  const before = await snapshot();
  assert.equal(before.gitStatus, '', 'Task C starts from a clean pinned checkout');
  const commit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  assert.equal(commit, '22d924701a6ae2e4cd01e9a15bbaf3946094af65');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, files[0])));
  const editor = await vscode.window.showTextDocument(document);
  const functionLine = document.getText().split('\n').findIndex(line => line.startsWith('def get_debug_flag('));
  assert.ok(functionLine >= 0);
  editor.selection = new vscode.Selection(functionLine, 0, functionLine, 0);
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const settings = vscode.workspace.getConfiguration('secureforge');
  const previousUrl = settings.inspect('trueforgeUrl').globalValue;
  const previousModel = settings.inspect('model').globalValue;
  const errors = [];
  const subscription = api.subscribe(event => { if (event.type === 'error') errors.push(event.message); });
  const prompt = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
  try {
    await settings.update('trueforgeUrl', `http://127.0.0.1:${port}`, vscode.ConfigurationTarget.Global);
    await settings.update('model', 'task-c/unavailable', vscode.ConfigurationTarget.Global);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(vscode.workspace.getConfiguration('secureforge').get('model'), 'task-c/unavailable');
    const started = Date.now();
    let finished = false;
    const run = vscode.commands.executeCommand('secureforge.runBuild', prompt).finally(() => { finished = true; });
    const probeStarted = Date.now();
    await vscode.commands.executeCommand('cursorMove', { to: 'right', by: 'character', value: 1 });
    const responsiveMs = Date.now() - probeStarted;
    const responsiveWhilePending = !finished;
    await run;
    assert.ok(errors.some(message => /TrueForge run failed/.test(message)), 'Real extension shows the connection failure: ' + JSON.stringify(errors));
    assert.ok(!errors.some(message => /\n\s*at /.test(message)), 'Notification omits a stack trace');
    assert.ok(responsiveWhilePending, 'Editor cursor command completes while the Build is pending');
    const after = await snapshot();
    assert.deepEqual(after, before);
    assert.ok(vscode.workspace.textDocuments.filter(doc => doc.uri.fsPath.startsWith(root + path.sep)).every(doc => !doc.isDirty));
    const result = { mode: 'real packaged VS Code extension with actual SDK unreachable-endpoint failure',
      flaskCommit: commit, prompt, error: errors.at(-1), elapsedMs: Date.now() - started,
      editorProbe: { command: 'cursorMove', elapsedMs: responsiveMs, completedWhileBuildPending: responsiveWhilePending },
      unchanged: true, before, after,
      limitation: 'This is an automated editor check. The official A/B/C recording remains pending.' };
    if (process.env.SECUREFORGE_EDITOR_FAILURE_REPORT) {
      await fs.writeFile(process.env.SECUREFORGE_EDITOR_FAILURE_REPORT, JSON.stringify(result, null, 2));
    }
    return result;
  } finally {
    subscription.dispose();
    await settings.update('trueforgeUrl', previousUrl, vscode.ConfigurationTarget.Global);
    await settings.update('model', previousModel, vscode.ConfigurationTarget.Global);
  }
};
