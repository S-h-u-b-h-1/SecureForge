import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const CODE_EXTENSIONS = new Set([
  '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.go', '.rs', '.java',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.html', '.css', '.scss', '.json', '.toml',
  '.yaml', '.yml', '.md', '.txt', '.sql', '.sh', '.ini', '.cfg', '.xml', '.vue',
]);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build',
  'coverage', '.next', '.cache', '__pycache__', '.idea', '.vscode']);
const RESTRICTED_NAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519)|credentials(?:\..*)?|secrets?(?:\..*)?)$/i;
const RESTRICTED_SUFFIX = /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|keystore)$/i;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_READ_LINES = 180;

function safeRelativeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || path.isAbsolute(name)) {
    throw new Error('A nonempty workspace-relative path is required');
  }
  const segments = name.replaceAll('\\', '/').split('/');
  if (segments.some((s) => !s || s === '.' || s === '..')) throw new Error('Unsafe path component');
  if (segments.some((s) => SKIP_DIRS.has(s) || RESTRICTED_NAMES.test(s) || RESTRICTED_SUFFIX.test(s))) {
    throw new Error('Restricted file path');
  }
  return segments.join('/');
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function redactSecrets(content) {
  return content
    .replace(/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*["']?)([^\s"',;]+)/gi, '$1[REDACTED]');
}

export class Workspace {
  constructor(root) {
    if (!root || typeof root !== 'string') throw new Error('Workspace root is required');
    this.requestedRoot = path.resolve(root);
    this.root = null;
  }

  async init() {
    this.root = await realpath(this.requestedRoot);
    if (!(await lstat(this.root)).isDirectory()) throw new Error('Workspace root is not a directory');
    return this;
  }

  #requireRoot() {
    if (!this.root) throw new Error('Call workspace.init() first');
  }

  async #resolveFile(relPath) {
    this.#requireRoot();
    const rel = safeRelativeName(relPath);
    const candidate = path.resolve(this.root, rel);
    const within = path.relative(this.root, candidate);
    if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('Path leaves workspace');
    // Reject all symlink components, including internal symlinks: fail closed against link swaps.
    let cursor = this.root;
    for (const segment of rel.split('/')) {
      cursor = path.join(cursor, segment);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symlink access is not permitted');
    }
    const canonical = await realpath(candidate);
    const actual = path.relative(this.root, canonical);
    if (!actual || actual.startsWith('..') || path.isAbsolute(actual)) throw new Error('Path leaves workspace');
    if (!(await lstat(candidate)).isFile()) throw new Error('Not a regular file');
    return { absolute: candidate, relative: rel };
  }

  async #readRaw(relPath) {
    const { absolute, relative } = await this.#resolveFile(relPath);
    const stat = await lstat(absolute);
    if (stat.size > MAX_FILE_BYTES) throw new Error('File exceeds 256 KiB limit');
    const buf = await readFile(absolute);
    if (buf.length > MAX_FILE_BYTES) throw new Error('File exceeds 256 KiB limit');
    if (buf.includes(0)) throw new Error('Binary file not supported');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { relative, raw: decoded, hash: sha256(buf) };
  }

  async readFile(relPath, { startLine = 1, maxLines = 100 } = {}) {
    if (!Number.isInteger(startLine) || startLine < 1) throw new Error('startLine must be >= 1');
    if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > MAX_READ_LINES) {
      throw new Error(`maxLines must be 1..${MAX_READ_LINES}`);
    }
    const { relative, raw, hash } = await this.#readRaw(relPath);
    const lines = raw.split(/\r?\n/);
    const from = Math.min(startLine - 1, lines.length);
    const selected = lines.slice(from, from + maxLines).map((text, i) => ({
      line: from + i + 1, text: redactSecrets(text),
    }));
    return { path: relative, sha256: hash, startLine: from + 1, endLine: from + selected.length,
      totalLines: lines.length, truncated: from + maxLines < lines.length,
      redacted: redactSecrets(raw) !== raw, lines: selected };
  }

  async rawForProposal(relPath) {
    return this.#readRaw(relPath);
  }

  async listFiles({ maxFiles = 2500 } = {}) {
    this.#requireRoot();
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 5000) throw new Error('Invalid maxFiles');
    const queue = [''];
    const results = [];
    while (queue.length && results.length < maxFiles) {
      const base = queue.shift();
      const entries = await readdir(path.join(this.root, base), { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (RESTRICTED_NAMES.test(entry.name) || RESTRICTED_SUFFIX.test(entry.name)) continue;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) queue.push(rel);
        } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          results.push(rel);
          if (results.length >= maxFiles) break;
        }
      }
    }
    return results;
  }

  async searchWorkspace(query, { maxResults = 20, maxFiles = 500 } = {}) {
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 120) {
      throw new Error('Search query must contain 2..120 characters');
    }
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
      throw new Error('maxResults must be 1..50');
    }
    const term = query.toLowerCase();
    const all = await this.listFiles({ maxFiles });
    const matches = [];
    for (const file of all) {
      try {
        const { raw, hash } = await this.#readRaw(file);
        const lines = raw.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(term)) {
            matches.push({ path: file, line: i + 1, snippet: redactSecrets(lines[i].slice(0, 260)), sha256: hash });
            if (matches.length >= maxResults) break;
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT' && !/(limit|Binary|Symlink|Restricted)/.test(err.message)) throw err;
      }
      if (matches.length >= maxResults) break;
    }
    return { query, searchedFiles: all.length, matches, capped: matches.length === maxResults };
  }

  async lookupSymbol(symbol, options = {}) {
    if (typeof symbol !== 'string' || !/^[A-Za-z_$][\w$]{1,99}$/.test(symbol)) {
      throw new Error('Symbol must be a simple identifier of length 2..100');
    }
    // Lexical candidate lookup, not a language-server or AST definition resolver.
    return this.searchWorkspace(symbol, options);
  }
}
