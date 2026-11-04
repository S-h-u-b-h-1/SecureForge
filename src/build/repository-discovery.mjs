import path from 'node:path';

// B1 Build-only component. No direct filesystem access: the caller must supply
// the existing, security-hardened Workspace implementation.
export const MAX_DISCOVERY_FILES = 300;
export const MAX_DISCOVERY_RESULTS = 20;
const MAX_READ_LINES = 180;
const MAX_SNIPPET_CHARS = 160;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'change', 'changes',
  'code', 'could', 'do', 'does', 'feature', 'file', 'files', 'find', 'fix',
  'for', 'from', 'function', 'get', 'have', 'how', 'i', 'in', 'into', 'is',
  'it', 'make', 'new', 'of', 'on', 'or', 'our', 'please', 'project', 'should',
  'some', 'support', 'that', 'the', 'their', 'them', 'there', 'these',
  'this', 'to', 'update', 'use', 'using', 'want', 'we', 'when', 'where',
  'which', 'with', 'would', 'you', 'your', 'implement', 'add', 'handle',
]);

function words(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function queryTerms(task) {
  const terms = [...new Set(words(task).filter((word) =>
    (word.length >= 3 || ['db', 'ui', 'js', 'ts', 'go'].includes(word)) && !STOP_WORDS.has(word)
  ))];
  return terms.slice(0, 16);
}

function validateLimit(value, max, name) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
}

function hasTerm(textWords, term) {
  return textWords.has(term);
}

function uniqueImports(source, filename, available) {
  const results = new Map();
  const extension = path.posix.extname(filename).toLowerCase();
  const dirname = path.posix.dirname(filename);

  function add(modulePath, lineNumber) {
    if (!modulePath || modulePath.startsWith('/') || modulePath.startsWith('../') || modulePath === '..') return;
    const candidate = path.posix.normalize(modulePath);
    if (candidate === filename || candidate.startsWith('../')) return;
    const suffixes = extension === '.py'
      ? ['.py', '/__init__.py']
      : ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '/index.js', '/index.ts', '/index.tsx'];
    const variants = path.posix.extname(candidate) ? [candidate] : suffixes.map((s) => candidate + s);
    const target = variants.find((variant) => available.has(variant));
    if (target && !results.has(target)) results.set(target, { path: target, line: lineNumber });
  }

  for (const { text, line } of source) {
    const snippet = text.slice(0, 2000);
    if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(extension)) {
      // Literal relative ES imports/exports and require(). This is lexical,
      // not AST resolution; package aliases and computed paths are excluded.
      const patterns = [
        /\b(?:import|export)\b[^'"\n]{0,300}?\bfrom\s*['"](\.{1,2}\/[^'"\n]+)['"]/g,
        /\bimport\s*['"](\.{1,2}\/[^'"\n]+)['"]/g,
        /\b(?:require|import)\s*\(\s*['"](\.{1,2}\/[^'"\n]+)['"]\s*\)/g,
      ];
      for (const pattern of patterns) {
        for (const match of snippet.matchAll(pattern)) add(path.posix.join(dirname, match[1]), line);
      }
    } else if (extension === '.py') {
      const from = /^\s*from\s+(\.+[a-zA-Z_][\w.]*|\.+)\s+import\s+([A-Za-z_]\w*)/.exec(snippet);
      if (from) {
        const moduleName = from[1];
        const dots = /^\.+/.exec(moduleName)[0].length;
        const relativeParts = moduleName.slice(dots).split('.').filter(Boolean);
        const parents = dirname === '.' ? [] : dirname.split('/');
        const keep = Math.max(0, parents.length - (dots - 1));
        const parent = parents.slice(0, keep);
        const modulePath = [...parent, ...relativeParts].join('/');
        if (relativeParts.length) add(modulePath, line);
        // "from . import helpers" also makes the imported module available.
        if (moduleName === '.'.repeat(dots)) add([...parent, from[2]].join('/'), line);
      }
      const direct = /^\s*import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/.exec(snippet);
      if (direct) add(direct[1].replaceAll('.', '/'), line);
    }
  }
  return [...results.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Rank files relevant to a task using only Workspace.listFiles/readFile.
 * This is bounded lexical evidence, NOT a semantic/AST analysis or safety verdict.
 * Returned line snippets are redacted by Workspace; fully redacted files are
 * excluded entirely to avoid recommending edits to partially masked sources.
 */
export async function discoverRelevantFiles({
  workspace, task, maxFiles = 160, maxCandidates = 12, maxEvidenceLines = 3, signal,
} = {}) {
  if (!workspace || typeof workspace.listFiles !== 'function' || typeof workspace.readFile !== 'function') {
    throw new Error('A secure Workspace with listFiles/readFile is required');
  }
  if (typeof task !== 'string' || task.trim().length < 3 || task.length > 400) {
    throw new Error('task must have 3..400 characters');
  }
  validateLimit(maxFiles, MAX_DISCOVERY_FILES, 'maxFiles');
  validateLimit(maxCandidates, MAX_DISCOVERY_RESULTS, 'maxCandidates');
  validateLimit(maxEvidenceLines, 5, 'maxEvidenceLines');
  const terms = queryTerms(task);
  if (!terms.length) throw new Error('Task must include at least one searchable term');
  const assertActive = () => { if (signal?.aborted) throw new Error('Repository discovery cancelled'); };
  assertActive();

  const listed = await workspace.listFiles({ maxFiles });
  if (!Array.isArray(listed)) throw new Error('Workspace file listing is invalid');
  // Defensive: a faulty adapter must not turn the file scan into an unbounded read.
  const paths = [...new Set(listed.slice(0, maxFiles))].sort();
  const catalog = new Set(paths);
  const entries = new Map();
  let skipped = 0;
  let redacted = 0;
  let truncated = 0;

  for (const filename of paths) {
    assertActive();
    if (typeof filename !== 'string' || !filename || filename.length > 1024) { skipped++; continue; }
    let doc;
    try {
      doc = await workspace.readFile(filename, { startLine: 1, maxLines: MAX_READ_LINES });
    } catch {
      skipped++;
      continue;
    }
    // Fail closed for incomplete / inconsistent adapter output.
    if (!doc || doc.path !== filename || !/^[0-9a-f]{64}$/.test(doc.sha256) || !Array.isArray(doc.lines)) {
      skipped++;
      continue;
    }
    if (doc.redacted) { redacted++; continue; }
    if (doc.truncated) truncated++;

    const basename = path.posix.basename(filename, path.posix.extname(filename));
    const baseTokens = new Set(words(basename));
    const directoryTokens = new Set(words(path.posix.dirname(filename)));
    const matchedName = terms.filter((word) => hasTerm(baseTokens, word));
    const matchedDirectory = terms.filter((word) => hasTerm(directoryTokens, word));
    const matchedBody = new Set();
    const evidence = [];
    const safeLines = [];
    for (const entry of doc.lines.slice(0, MAX_READ_LINES)) {
      if (!Number.isInteger(entry.line) || entry.line < 1 || typeof entry.text !== 'string') continue;
      const visible = entry.text.slice(0, 2000);
      safeLines.push({ line: entry.line, text: visible });
      // Never return even redaction markers as evidence. These excerpts are
      // code references, not instructions or validated security findings.
      const hits = terms.filter((word) => hasTerm(new Set(words(visible)), word));
      if (hits.length) {
        for (const hit of hits) matchedBody.add(hit);
        if (evidence.length < maxEvidenceLines && !visible.includes('[REDACTED')) {
          evidence.push({ line: entry.line, excerpt: visible.trim().slice(0, MAX_SNIPPET_CHARS) });
        }
      }
    }
    const directScore = matchedName.length * 12 + matchedDirectory.length * 5 + Math.min(24, matchedBody.size * 6);
    entries.set(filename, {
      path: filename, sha256: doc.sha256, directScore, score: directScore,
      matchedName, matchedDirectory, matchedBody: [...matchedBody].sort(),
      evidence, safeLines, truncated: Boolean(doc.truncated), imports: [], importedBy: [],
      relatedPaths: [],
    });
  }

  const inspected = new Set(entries.keys());
  for (const entry of entries.values()) {
    entry.imports = uniqueImports(entry.safeLines, entry.path, inspected);
    for (const dep of entry.imports) entries.get(dep.path).importedBy.push({ path: entry.path, line: dep.line });
  }
  for (const entry of entries.values()) {
    entry.importedBy.sort((a, b) => a.path.localeCompare(b.path));
    // A single-hop hint is intentionally weak: it makes neighboring tests
    // and helpers discoverable, but cannot overwhelm lexical task evidence.
    const neighborPaths = new Set([
      ...entry.imports.map((link) => link.path),
      ...entry.importedBy.map((link) => link.path),
    ]);
    entry.relatedPaths = [...neighborPaths].filter((neighbor) =>
      entries.get(neighbor)?.directScore >= 12
    ).sort().slice(0, 5);
    if (entry.relatedPaths.length) entry.score += 4;
  }

  const candidates = [...entries.values()]
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxCandidates)
    .map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      score: entry.score,
      reasons: [
        ...(entry.matchedName.length ? [`filename: ${entry.matchedName.join(', ')}`] : []),
        ...(entry.matchedDirectory.length ? [`directory: ${entry.matchedDirectory.join(', ')}`] : []),
        ...(entry.matchedBody.length ? [`source: ${entry.matchedBody.join(', ')}`] : []),
        ...(entry.relatedPaths.length ? ['one-hop import relationship with relevant file'] : []),
      ],
      evidence: entry.evidence,
      imports: entry.imports.slice(0, 12),
      importedBy: entry.importedBy.slice(0, 12),
      truncated: entry.truncated,
    }));
  return {
    schemaVersion: 1,
    task,
    terms,
    coverage: {
      listedFiles: paths.length, inspectedFiles: entries.size,
      skippedFiles: skipped, redactedFiles: redacted,
      truncatedFiles: truncated, mayBeCapped: listed.length >= maxFiles,
      maxReadLinesPerFile: MAX_READ_LINES,
    },
    candidates,
    limitations: 'Lexical ranking and literal relative imports only; no AST or semantic proof. Evidence is bounded and untrusted. No file modifications.',
  };
}
