import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './workspace.mjs';

async function executablePath(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* Try the next executable directory. */ }
  }
  throw new Error(`Executable not found: ${name}`);
}

export async function prepareCommand(workspace, request) {
  if (!request || !['node', 'python3'].includes(request.executable) || !Array.isArray(request.args) ||
      request.args.some(arg => typeof arg !== 'string' || arg.length > 500)) {
    throw new Error('Only reviewed node --test or python3 -m pytest commands are supported');
  }
  const args = [...request.args];
  let files;
  if (request.executable === 'node' && args[0] === '--test') {
    files = args.slice(1);
    if (!files.length || files.some(file => file.startsWith('-') || !/\.(?:test|spec)\.(?:mjs|cjs|js)$/.test(file))) {
      throw new Error('Node verification requires explicit test files');
    }
  } else if (request.executable === 'python3' && args[0] === '-m' && args[1] === 'pytest') {
    files = args.slice(2).filter(arg => !['-q', '-x', '--disable-warnings'].includes(arg));
    if (!files.length || files.some(file => !/(?:^|\/)test_[\w.-]+\.py$/.test(file))) {
      throw new Error('Pytest verification requires explicit test files and supported flags');
    }
  } else {
    throw new Error('Unsupported verification command');
  }
  if (files.length > 20 || args.length > 25) throw new Error('Too many verification arguments');
  const sources = [];
  for (const file of files) {
    const source = await workspace.rawForProposal(file);
    sources.push({ path: source.relative, sha256: source.hash });
  }
  if (request.evidencePaths && (!Array.isArray(request.evidencePaths) || request.evidencePaths.length > 8)) {
    throw new Error('At most eight evidence paths are allowed');
  }
  const targets = [];
  for (const file of request.evidencePaths ?? []) {
    const source = await workspace.rawForProposal(file);
    targets.push({ path: source.relative, sha256: source.hash });
  }
  return Object.freeze({
    executable: await executablePath(request.executable),
    args: Object.freeze(args), cwd: workspace.root,
    sources: Object.freeze(sources.map(source => Object.freeze(source))),
    targets: Object.freeze(targets.map(source => Object.freeze(source))),
    timeoutMs: Math.min(Math.max(request.timeoutMs ?? 30000, 100), 120000),
  });
}

export async function runApprovedCommand({ workspace, request, approve, signal }) {
  signal?.throwIfAborted();
  const command = await prepareCommand(workspace, request);
  if (!Number.isFinite(command.timeoutMs)) throw new Error('Invalid command timeout');
  if (await approve(command) !== true) {
    return { id: randomUUID(), status: 'denied', command, executed: false, output: '' };
  }
  signal?.throwIfAborted();
  for (const source of [...command.sources, ...command.targets]) {
    if ((await workspace.rawForProposal(source.path)).hash !== source.sha256) {
      throw new Error('Verification test changed after approval');
    }
  }
  signal?.throwIfAborted();
  const started = Date.now();
  const environment = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return new Promise(resolve => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd, env: environment, shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let byteCount = 0;
    let truncated = false;
    let reason;
    let killTimer;
    function terminate(status) {
      if (reason) return;
      reason = status;
      const kill = signalName => {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signalName); }
        catch { /* The process may already have exited. */ }
      };
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 500);
    }
    function capture(chunk) {
      const remaining = Math.max(0, 64 * 1024 - byteCount);
      if (chunk.length > remaining) truncated = true;
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      byteCount += Math.min(chunk.length, remaining);
    }
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timeout = setTimeout(() => terminate('timed_out'), command.timeoutMs);
    const abort = () => terminate('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let spawnError;
    child.on('error', error => { spawnError = error.code || 'SPAWN_ERROR'; });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      resolve({
        id: randomUUID(), command, executed: !spawnError,
        status: reason || (spawnError ? 'error' : exitCode === 0 ? 'passed' : 'failed'),
        exitCode, signal: exitSignal, durationMs: Date.now() - started,
        output: redactSecrets(Buffer.concat(chunks).toString('utf8')),
        truncated, ...(spawnError ? { error: spawnError } : {}),
      });
    });
  });
}
