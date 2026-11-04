import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Owned test fixture: userPath is an untrusted filename supplied by the caller.
export function readNote(root, userPath) {
  return readFileSync(join(root, userPath), 'utf8');
}
