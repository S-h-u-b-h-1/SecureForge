import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

try {
  const child = spawn(executable, [
    '--new-window', '--wait', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--user-data-dir', path.join(runDirectory, 'profile'),
    '--extensions-dir', path.join(runDirectory, 'extensions'),
    `--extensionDevelopmentPath=${path.join(root, 'extension')}`,
    `--extensionTestsPath=${path.join(root, 'test/editor/run.cjs')}`,
    root,
  ], { stdio: 'inherit', env: { ...process.env, SECUREFORGE_EDITOR_REPORT: reportPath } });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (signal) reject(new Error(`Editor test process ended with ${signal}`));
      else resolve(exitCode);
    });
  });
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  await writeFile(path.join(temporaryRoot, 'editor-test-report.json'), JSON.stringify(report, null, 2));
  if (code !== 0 || report.error || !report.passed?.length) {
    throw new Error(report.error || `Editor tests exited with ${code}`);
  }
  for (const result of report.passed) console.log(`PASS ${result}`);
  console.log(`Editor report: ${reportPath}`);
} catch (error) {
  console.error(`Editor verification failed: ${error.message}`);
  if (error.code === 'ENOENT' && error.syscall?.startsWith('spawn')) {
    console.error('Install desktop VS Code or set SECUREFORGE_CODE_PATH to its CLI executable.');
  } else {
    console.error(`Inspect editor diagnostics under ${runDirectory}`);
  }
  process.exitCode = 1;
}
