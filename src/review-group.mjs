import { randomUUID } from 'node:crypto';
import { createReview } from './review.mjs';

export function createReviewGroup(payload) {
  const proposals = Array.isArray(payload?.proposals) ? payload.proposals : [payload];
  if (proposals.length < 1 || proposals.length > 8) throw new Error('Review requires 1..8 full proposals');
  const files = proposals.map(createReview);
  const paths = new Set(files.map(file => file.path.replaceAll('\\', '/').normalize('NFC').toLowerCase()));
  const ids = new Set(files.map(file => file.id));
  if (paths.size !== files.length || ids.size !== files.length) throw new Error('Duplicate review file or proposal ID');
  const bytes = proposals.reduce((total, proposal) => total + Buffer.byteLength(proposal.proposedContent), 0);
  if (bytes > 256 * 1024) throw new Error('Review group exceeds 256 KiB of proposed content');
  return Object.freeze({
    id: payload?.id || randomUUID(),
    files: Object.freeze(files),
    createdAt: new Date().toISOString(),
  });
}
