import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ProposalStore } from './proposals.mjs';
import { redactSecrets } from './workspace.mjs';

const RULES = [
  {
    id: 'SF-PATH-001', title: 'Joined filename reaches a filesystem read',
    pattern: /readFileSync\s*\(\s*(?:path\.)?join\s*\(\s*\w+\s*,\s*\w+\s*\)/g,
    impact: 'A user-controlled filename may escape the intended directory through parent paths or symlinks.',
    confidence: 'medium',
  },
  {
    id: 'SF-CMD-001', title: 'Interpolated text reaches a shell command',
    pattern: /\b(?:exec|execSync)\s*\(\s*`[^`]*\$\{/g,
    impact: 'Untrusted interpolated text may become shell syntax. Inspect its source and use executable/argument APIs.',
    confidence: 'medium',
  },
  {
    id: 'SF-SQL-001', title: 'Interpolated query reaches database execution',
    pattern: /\b(?:execute|query)\s*\(\s*(?:f["']|`[^`]*\$\{)/g,
    impact: 'Untrusted values may alter query structure. Verify data flow and parameter binding.',
    confidence: 'low',
  },
];

// Bounded lexical tracing for simple Python handlers. Every result needs review.
function tracePythonInputs(raw, path, hash) {
  if (!path.endsWith('.py')) return [];
  const findings = [];
  const values = new Map();
  const lines = raw.split(/\r?\n/);
  let functionIndent;
  for (let index = 0; index < lines.length && findings.length < 25; index++) {
    const text = lines[index];
    if (!text.trim() || text.trimStart().startsWith('#')) continue;
    const indent = text.length - text.trimStart().length;
    if (/^\s*(?:async\s+)?(?:def|class)\s/.test(text) ||
        (functionIndent !== undefined && indent <= functionIndent)) {
      values.clear();
      functionIndent = /^\s*(?:async\s+)?def\s/.test(text) ? indent : undefined;
    }
    for (const [name, trace] of values) {
      if (index - trace[0].line >= 50) values.delete(name);
    }
    const source = /\brequest\.(?:args|form|json|values|headers|cookies)\b/;
    const references = expression => [...values].filter(([name, trace]) =>
      index - trace[0].line < 50 && new RegExp(`\\b${name}\\b`).test(expression));
    const assignment = text.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.+)$/);
    if (assignment) {
      const [, name, expression] = assignment;
      const trace = source.test(expression) ? [] : references(expression)[0]?.[1];
      values.delete(name);
      if (trace && trace.length < 8) values.set(name, [...trace, {
        line: index + 1, evidence: redactSecrets(text).slice(0, 500),
      }]);
    }
    const sink = text.match(/\b((?:cursor|db)\.execute|os\.system|subprocess\.(?:run|call|Popen))\s*\(([^,\n]*)/);
    if (!sink || (sink[1].startsWith('subprocess.') && !/shell\s*=\s*True/.test(text))) continue;
    const trace = source.test(sink[2]) ? [] : references(sink[2])[0]?.[1];
    if (!trace) continue;
    findings.push({
      id: randomUUID(), ruleId: 'SF-FLOW-001', title: 'Request input reaches a sensitive Python call',
      path, line: index + 1, sourceSha256: hash, evidence: redactSecrets(text).slice(0, 500),
      trace: [...trace, { line: index + 1, evidence: redactSecrets(text).slice(0, 500) }],
      impact: 'Inspect whether request data controls SQL structure or shell syntax.',
      confidence: 'low', status: 'candidate', verification: 'not_run',
      limitation: 'Lexical, same-function trace with 50-line and 8-assignment bounds. Aliases, strings, sanitizers, branches and interprocedural flows require manual analysis.',
    });
  }
  return findings;
}

export function inspectSecuritySource({ path, raw, hash }) {
  const findings = [];
  for (const rule of RULES) {
    for (const match of raw.matchAll(new RegExp(rule.pattern))) {
      const line = raw.slice(0, match.index).split('\n').length;
      findings.push({
        id: randomUUID(), ruleId: rule.id, title: rule.title, path, line,
        sourceSha256: hash, evidence: redactSecrets(raw.split(/\r?\n/)[line - 1]).slice(0, 500),
        impact: rule.impact, confidence: rule.confidence, status: 'candidate', verification: 'not_run',
        limitation: 'Pattern-based candidate. Caller-controlled input and surrounding safeguards require inspection.',
      });
      if (findings.length >= 50) break;
    }
  }
  const masked = redactSecrets(raw);
  if (masked !== raw) {
    findings.push({
      id: randomUUID(), ruleId: 'SF-SECRET-001', title: 'Potential credential literal', path,
      line: masked.split(/\r?\n/).findIndex(line => line.includes('[REDACTED')) + 1,
      sourceSha256: hash, evidence: 'A supported credential pattern was redacted. Value omitted.',
      impact: 'A credential literal may enter source control, logs or model context.',
      confidence: 'medium', status: 'candidate', verification: 'not_run',
      limitation: 'Heuristic detection can miss secret formats or flag dummy values.',
    });
  }
  return [...findings, ...tracePythonInputs(raw, path, hash)];
}

export async function reviewSecurity(workspace, { paths, signal, maxFiles = 250 } = {}) {
  const files = paths ?? await workspace.listFiles({ maxFiles, signal });
  if (!Array.isArray(files) || files.length > 250) throw new Error('Review requires at most 250 file paths');
  const findings = [];
  const sources = [];
  const skipped = [];
  let bytes = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    try {
      const source = await workspace.rawForProposal(file);
      bytes += Buffer.byteLength(source.raw);
      if (bytes > 2 * 1024 * 1024) {
        skipped.push({ path: file, reason: 'Total review budget reached (2 MiB)' });
        break;
      }
      sources.push({ path: source.relative, sha256: source.hash });
      findings.push(...inspectSecuritySource({ path: source.relative, raw: source.raw, hash: source.hash }));
      if (findings.length >= 100) break;
    } catch (error) {
      skipped.push({ path: file, reason: 'File could not be safely reviewed' });
    }
  }
  signal?.throwIfAborted();
  return {
    id: randomUUID(), createdAt: new Date().toISOString(), mode: 'read-only static review',
    sources, findings: findings.slice(0, 100), skipped,
    limitations: ['Four narrow pattern checks and bounded lexical Python input traces; no complete authorization or interprocedural analysis.',
      'No finding is labelled exploitable without separate evidence.',
      'Excluded files, budgets and unsupported patterns limit coverage.'],
  };
}

export async function prepareOwnedFixtureFix(workspace, finding) {
  if (finding.ruleId !== 'SF-PATH-001') throw new Error('Use the Build agent to prepare this candidate fix');
  const source = await workspace.rawForProposal(finding.path);
  if (source.hash !== finding.sourceSha256) throw new Error('Security finding is stale; review the source again');
  const vulnerable = await readFile(new URL('../fixtures/security-lab/vulnerable/storage.mjs', import.meta.url), 'utf8');
  const fixed = await readFile(new URL('../fixtures/security-lab/safe/storage.mjs', import.meta.url), 'utf8');
  if (source.raw !== vulnerable) throw new Error('Automatic template repair applies only to the owned security fixture');
  const proposals = new ProposalStore(workspace);
  const summary = await proposals.proposeEdit({
    path: finding.path, expectedSha256: finding.sourceSha256, proposedContent: fixed,
    rationale: 'Owned fixture repair: enforce the canonical notes-directory boundary. Review and test before accepting the security claim.',
  });
  return proposals.getProposal(summary.id);
}
