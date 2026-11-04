import path from 'node:path';
import { redactSecrets } from './workspace.mjs';

const STOP_WORDS = new Set(['the', 'and', 'with', 'that', 'this', 'from', 'into', 'add', 'new', 'must', 'any', 'for', 'its', 'which', 'also', 'show', 'make', 'update']);

export function parseMentions(task) {
  const files = [...task.matchAll(/@file:(?:"([^"]+)"|([^\s]+))/g)].map(match => match[1] ?? match[2]);
  const symbols = [...task.matchAll(/@symbol:([A-Za-z_$][\w$]{1,99})/g)].map(match => match[1]);
  if (files.length + symbols.length > 12) throw new Error('Attach at most 12 file/symbol mentions');
  return {
    files: [...new Set(files)].filter(file => redactSecrets(file) === file),
    symbols: [...new Set(symbols)].filter(symbol => redactSecrets(symbol) === symbol),
  };
}

export async function assembleContext(workspace, task, { budgetBytes = 24000, signal, selectedPath } = {}) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('A context request is required');
  if (!Number.isInteger(budgetBytes) || budgetBytes < 2000 || budgetBytes > 96000) throw new Error('Context budget must be 2000..96000 UTF-8 bytes');
  const mentions = parseMentions(task);
  if (selectedPath && redactSecrets(selectedPath) === selectedPath && !mentions.files.includes(selectedPath)) mentions.files.unshift(selectedPath);
  const terms = [...new Set(redactSecrets(task).replace(/@(?:file|symbol):(?:"[^"]+"|\S+)/g, '').toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [])]
    .filter(term => !STOP_WORDS.has(term)).slice(0, 24);
  const listed = await workspace.listFiles({ maxFiles: 2500 });
  const files = [...new Set([...mentions.files, ...listed])];
  const candidates = [];
  const skipped = [];
  let scannedBytes = 0;
  let scannedFiles = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    if (redactSecrets(file) !== file) {
      skipped.push({ reason: 'Credential-bearing path excluded' });
      continue;
    }
    try {
      const source = await workspace.rawForProposal(file);
      if (redactSecrets(source.relative) !== source.relative) {
        skipped.push({ reason: 'Credential-bearing path excluded' });
        continue;
      }
      scannedBytes += Buffer.byteLength(source.raw);
      if (scannedBytes > 4 * 1024 * 1024) { skipped.push({ path: file, reason: '4 MiB scan budget reached' }); break; }
      scannedFiles++;
      if (redactSecrets(source.raw) !== source.raw) {
        skipped.push({ path: file, reason: 'Source excluded because credential patterns were detected' });
        continue;
      }
      const lines = source.raw.split(/\r?\n/);
      const name = file.toLowerCase();
      const nameTerms = terms.filter(term => name.includes(term));
      const explicit = mentions.files.includes(file);
      const symbolLine = lines.findIndex(line => mentions.symbols.some(symbol => (line.match(/[A-Za-z_$][\w$]*/g) ?? []).includes(symbol)));
      let bestLine = 0;
      let bestScore = 0;
      for (let index = 0; index < lines.length; index++) {
        const score = terms.filter(term => lines[index].toLowerCase().includes(term)).length;
        if (score > bestScore) { bestScore = score; bestLine = index; }
      }
      const score = (explicit ? 1000 : 0) + (symbolLine >= 0 ? 500 : 0) + nameTerms.length * 12 + bestScore;
      if (!score) continue;
      candidates.push({ path: source.relative, sha256: source.hash, lines,
        center: symbolLine >= 0 ? symbolLine : bestLine, score,
        reason: explicit ? 'Explicit file/selection' : symbolLine >= 0 ? 'Explicit symbol match (lexical)'
          : `Task terms in ${nameTerms.length ? 'filename and source' : 'source'}: ${nameTerms.length ? nameTerms.join(', ') : terms.filter(term => lines[bestLine].toLowerCase().includes(term)).join(', ')}`,
      });
    } catch { skipped.push({ path: file, reason: 'File excluded by workspace read policy' }); }
  }
  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const primary = candidates.slice(0, 3);
  for (const candidate of candidates) {
    if (!/(?:^|\/)(?:test[^/]*|docs?)(?:\/|_|\.)/.test(candidate.path)) continue;
    const related = primary.find(source => path.basename(candidate.path).includes(path.parse(source.path).name));
    if (related && candidate.score < 500) {
      candidate.score += 30;
      candidate.reason += `; related test/documentation for ${related.path}`;
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const sources = [];
  let usedBytes = 2;
  for (const candidate of candidates) {
    if (sources.length >= 12) break;
    let start = Math.max(0, candidate.center - 8);
    let end = Math.min(candidate.lines.length, start + 60);
    let item;
    while (end > start) {
      item = { path: candidate.path, sha256: candidate.sha256, startLine: start + 1, endLine: end,
        reason: candidate.reason, content: candidate.lines.slice(start, end).join('\n') };
      if (usedBytes + Buffer.byteLength(JSON.stringify(item)) + (sources.length ? 1 : 0) <= budgetBytes) break;
      end--;
    }
    if (end === start) continue;
    sources.push(item);
    usedBytes = Buffer.byteLength(JSON.stringify(sources));
  }
  signal?.throwIfAborted();
  return { sources, budgetBytes, usedBytes, tokenEstimate: Math.ceil(usedBytes / 3),
    estimateMethod: 'UTF-8 bytes / 3, approximate; enforced budget is bytes',
    mentions, scannedFiles, skipped,
    limitations: ['Lexical search and bounded excerpts; caller graphs and AST symbol resolution are not inferred.'] };
}

export function validateInlineProposal(selection, proposal) {
  if (proposal.path !== selection.path || proposal.baseSha256 !== selection.baseSha256) {
    throw new Error('Inline proposal changed another file or a stale base');
  }
  const prefix = proposal.originalContent.slice(0, selection.startOffset);
  const suffix = proposal.originalContent.slice(selection.endOffset);
  if (proposal.proposedContent.length < prefix.length + suffix.length || !proposal.proposedContent.startsWith(prefix) ||
      !proposal.proposedContent.endsWith(suffix)) throw new Error('Inline proposal changed code outside the selected range');
}
