import { redactSecrets, sha256 } from '../workspace.mjs';

// Build-only read helper. It deliberately exposes no file writes, shell tools,
// model provider calls, or proposal application. The existing security-hardened
// Workspace descriptor-based reader remains the sole source of bytes.
export const MAX_SOURCE_BUNDLE_FILES = 4;
export const MAX_SOURCE_BUNDLE_BYTES = 96 * 1024;
const MAX_PATH_CHARACTERS = 1024;

function validatePaths(paths) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_SOURCE_BUNDLE_FILES) {
    throw new Error(`paths must contain 1..${MAX_SOURCE_BUNDLE_FILES} workspace files`);
  }
  const seen = new Set();
  for (const name of paths) {
    if (typeof name !== 'string' || !name || name.length > MAX_PATH_CHARACTERS ||
        name.includes('\0') || name.startsWith('/') || name.includes('\\') ||
        name.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error('Bundle requires safe canonical workspace-relative paths');
    }
    // Workspace's content masking does not protect path strings; never return
    // the caller's path when it contains a recognized credential pattern.
    if (redactSecrets(name) !== name) throw new Error('Credential-bearing path excluded');
    const key = name.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate source path in bundle');
    seen.add(key);
  }
}

/**
 * Returns complete source snapshots for the specific existing paths selected
 * by the model after independent discovery. No file is applied or changed.
 *
 * All files must pass the hardened Workspace.rawForProposal policy, credential
 * screening, integrity checks and the combined UTF-8 budget; otherwise the
 * entire call fails without emitting a partial source bundle.
 */
export async function readSourceBundle({ workspace, paths, signal } = {}) {
  if (!workspace || typeof workspace.rawForProposal !== 'function') {
    throw new Error('A security-hardened Workspace.rawForProposal is required');
  }
  validatePaths(paths);
  const assertActive = () => {
    if (signal?.aborted) throw new Error('Source bundle cancelled');
  };
  assertActive();

  let totalBytes = 0;
  const files = [];
  for (const name of paths) {
    assertActive();
    let source;
    try {
      source = await workspace.rawForProposal(name);
    } catch {
      assertActive();
      // Do not echo potentially sensitive filesystem errors or path names.
      throw new Error('Source excluded by workspace read policy');
    }
    assertActive();
    if (!source || source.relative !== name || typeof source.raw !== 'string' ||
        typeof source.hash !== 'string' || !/^[0-9a-f]{64}$/.test(source.hash) ||
        sha256(source.raw) !== source.hash) {
      throw new Error('Source bundle received inconsistent workspace data');
    }
    if (redactSecrets(source.relative) !== source.relative ||
        redactSecrets(source.raw) !== source.raw) {
      throw new Error('Credential-bearing source excluded');
    }
    const bytes = Buffer.byteLength(source.raw, 'utf8');
    totalBytes += bytes;
    if (totalBytes > MAX_SOURCE_BUNDLE_BYTES) {
      throw new Error('Source bundle exceeds 96 KiB of UTF-8 source content');
    }
    files.push({
      path: source.relative,
      sha256: source.hash,
      bytes,
      content: source.raw,  // exact LF/CRLF and trailing newline preserved
    });
  }
  assertActive();
  return {
    schemaVersion: 1,
    status: 'read_only',
    fileCount: files.length,
    totalBytes,
    files,
    limitations: 'Point-in-time per-file snapshots, not an atomic multi-file lock. SHA-256 must be rechecked by propose_batch and by the approval layer. Best-effort credential detection is not DLP.',
  };
}
