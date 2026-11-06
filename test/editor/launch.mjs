import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { waitForEditorReport } from './report-wait.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporaryRoot = path.join(root, '.tmp');
await mkdir(temporaryRoot, { recursive: true });
const runDirectory = await mkdtemp(path.join(temporaryRoot, 'editor-run-'));
const reportPath = path.join(runDirectory, 'report.json');
const executable = process.env.SECUREFORGE_CODE_PATH || (process.platform === 'darwin'
  ? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
  : 'code');
// Editor-host tests run in a separate VS Code profile. Prevent indefinite CLI
// waits and preserve a useful diagnostic location for stalled sessions.
const configuredTimeout = Number(process.env.SECUREFORGE_EDITOR_TIMEOUT_MS ?? 240000);
if (!Number.isInteger(configuredTimeout) || configuredTimeout < 30000 || configuredTimeout > 900000) {
  throw new Error('SECUREFORGE_EDITOR_TIMEOUT_MS must be an integer from 30000 to 900000');
}
console.log(`Starting isolated VS Code editor-host acceptance test.
Test workspace: ${process.env.SECUREFORGE_EDITOR_WORKSPACE || root}
Diagnostic report: ${reportPath}`);

let child;
const launchState = { exited: false, code: null, signal: null, error: null };
try {
  child = spawn(executable, [
    // --extensionTestsPath already manages the test-host lifecycle; --wait
    // can keep this CLI alive after the test script has written its final report.
    '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--user-data-dir', path.join(runDirectory, 'profile'),
    '--extensions-dir', path.join(runDirectory, 'extensions'),
    `--extensionDevelopmentPath=${process.env.SECUREFORGE_EXTENSION_PATH || path.join(root, 'extension')}`,
    `--extensionTestsPath=${path.join(root, 'test/editor/run.cjs')}`,
    process.env.SECUREFORGE_EDITOR_WORKSPACE || root,
  ], { stdio: 'inherit', env: { ...process.env, SECUREFORGE_EDITOR_REPORT: reportPath,
    SECUREFORGE_EDITOR_WIRE: process.argv.includes('--wire') ? '1' : '' } });
  child.once('error', error => { launchState.error = error; });
  child.once('exit', (code, signal) => {
    launchState.exited = true;
    launchState.code = code;
    launchState.signal = signal;
    console.log('VS Code launcher exited (' + (signal || code) + '); checking editor-host report.');
  });
  const report = await waitForEditorReport(reportPath, {
    timeoutMs: configuredTimeout,
    getLaunchState: () => launchState,
    onCheckpoint: value => console.log('Editor checkpoint: ' + value),
  });
  if (launchState.error) throw launchState.error;
  if (launchState.exited && (launchState.code !== 0 || launchState.signal)) {
    throw new Error('VS Code launcher failed with ' + (launchState.signal || launchState.code));
  }
  await writeFile(path.join(temporaryRoot, 'editor-test-report.json'), JSON.stringify(report, null, 2));
  if (report.error || !report.passed?.length) {
    throw new Error(report.error || 'Editor tests finished without any passing checks');
  }
  for (const result of report.passed) console.log(`PASS ${result}`);
  console.log(`Editor report: ${reportPath}`);
  // The host report is terminal. Do not hold the terminal open solely because
  // a detached VS Code CLI still owns an isolated test window.
  if (!launchState.exited) child.unref();
} catch (error) {
  if (child && !launchState.exited && child.pid) {
    child.kill('SIGTERM');
    child.unref();
  }
  console.error(`Editor verification failed: ${error.message}`);
  if (error.code === 'ENOENT' && error.syscall?.startsWith('spawn')) {
    console.error('Install desktop VS Code or set SECUREFORGE_CODE_PATH to its CLI executable.');
  } else {
    console.error(`Inspect editor diagnostics under ${runDirectory}`);
  }
  process.exitCode = 1;
}
