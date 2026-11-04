import { randomUUID } from 'node:crypto';
import { redactSecrets } from './workspace.mjs';

export function createPassport({ reviews = [], receipts = [], securityReports = [], proofs = [] } = {}) {
  const patches = reviews.map(record => ({
    id: record.group.id, sessionId: record.sessionId ?? null,
    recordedAt: record.recordedAt ?? new Date().toISOString(), status: record.result.status,
    actor: 'local user review',
    files: record.group.files.map(file => ({
      path: file.path, baseSha256: file.baseSha256,
      hunks: file.hunks.map(hunk => ({ id: hunk.id, line: hunk.startLine, decision: record.decisions[hunk.id] ?? 'pending' })),
    })),
    appliedFiles: record.result.files ?? [],
  }));
  const passport = {
    schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(),
    patches,
    verification: receipts.map(receipt => ({
      id: receipt.id, status: receipt.status, executed: receipt.executed,
      command: receipt.command, exitCode: receipt.exitCode ?? null,
      signal: receipt.signal ?? null, durationMs: receipt.durationMs ?? null,
      output: redactSecrets(receipt.output ?? '').slice(0, 64 * 1024), truncated: receipt.truncated ?? false,
    })),
    security: securityReports.map(report => ({
      id: report.id, createdAt: report.createdAt, mode: report.mode,
      sources: report.sources, findings: report.findings, skipped: report.skipped, limitations: report.limitations,
    })),
    proofs,
    uncertainties: [
      'A passed command records execution, not complete correctness or security coverage.',
      'Editor-buffer application and disk Save are separate operations.',
      'This is recorded event evidence; later external edits or native Undo may require a fresh review.',
      'Security findings remain candidates unless a specific controlled proof supports them.',
      'Secret redaction is best effort; review an exported report before sharing it.',
    ],
  };
  // Source text, complete proposals, prompts and model credentials are excluded.
  function sanitize(value) {
    if (typeof value === 'string') return redactSecrets(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitize(child)]));
    }
    return value;
  }
  return sanitize(passport);
}
