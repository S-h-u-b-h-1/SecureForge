import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Owned control fixture: resolve the existing target before checking its root.
export function readNote(root, userPath) {
  const allowedRoot = realpathSync(root);
  const target = realpathSync(resolve(allowedRoot, userPath));
  const inside = relative(allowedRoot, target);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('Path leaves the notes directory');
  }
  return readFileSync(target, 'utf8');
}
