import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, '.tmp'), { recursive: true });
const staging = await mkdtemp(path.join(root, '.tmp', 'vsix-'));
await mkdir(path.join(staging, 'dist'));
const manifest = JSON.parse(await readFile(path.join(root, 'extension/package.json'), 'utf8'));
manifest.main = './extension.cjs';
manifest.license = 'MIT';
manifest.repository = { type: 'git', url: 'https://github.com/S-h-u-b-h-1/SecureForge.git' };
manifest.scripts = {};
delete manifest.private;
await writeFile(path.join(staging, 'package.json'), JSON.stringify(manifest, null, 2));
await writeFile(path.join(staging, 'extension.cjs'), `const vscode = require('vscode');
exports.activate = async context => (await import('./dist/extension.mjs')).activate(context, vscode);
`);
await build({
  entryPoints: [path.join(root, 'extension/entry.mjs')], bundle: true, platform: 'node', format: 'esm',
  target: 'node20', outfile: path.join(staging, 'dist/extension.mjs'), external: ['vscode'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
for (const file of ['LICENSE', 'README.md']) await cp(path.join(root, file), path.join(staging, file));
await cp(path.join(root, 'extension/media'), path.join(staging, 'media'), { recursive: true });
await cp(path.join(root, 'docs'), path.join(staging, 'docs'), { recursive: true });
await cp(path.join(root, 'fixtures'), path.join(staging, 'fixtures'), { recursive: true });
const output = path.join(root, 'outputs', `SecureForge-${manifest.version}.vsix`);
await mkdir(path.dirname(output), { recursive: true });
const child = spawn('npx', ['--yes', '@vscode/vsce@4.1.0', 'package', '--no-dependencies', '--allow-missing-repository', '--out', output], {
  cwd: staging, stdio: 'inherit', shell: false,
});
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
if (code !== 0) throw new Error(`VSIX packaging failed (${code})`);
console.log(`Packaged extension: ${output}`);
