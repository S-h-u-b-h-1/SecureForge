import { randomUUID } from 'node:crypto';

// Build-only coordination layer. Individual entries keep the existing
// ProposalStore v1 contract consumed by the future approval UI.
export const MAX_BATCH_FILES = 8;
export const MAX_BATCH_CONTENT_BYTES = 256 * 1024;

export class BatchProposalStore {
  #batches = new Map();
  #inFlight = 0;

  constructor(proposals, { limit = 20 } = {}) {
    if (!proposals || typeof proposals.proposeEdit !== 'function' || typeof proposals.checkProposal !== 'function' || typeof proposals.discard !== 'function') {
      throw new Error('An existing ProposalStore is required');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid batch limit');
    this.proposals = proposals;
    this.limit = limit;
  }

  async proposeBatch({ edits, rationale = '' } = {}) {
    if (!Array.isArray(edits) || edits.length < 2 || edits.length > MAX_BATCH_FILES) {
      throw new Error('edits must contain 2..' + MAX_BATCH_FILES + ' files');
    }
    if (typeof rationale !== 'string' || rationale.length > 2000) throw new Error('Invalid batch rationale');
    // Include in-flight asynchronous staging, not just published batches.
    // Reservation is acquired before the first await to prevent concurrent
    // calls from exceeding the configured pending-batch capacity.
    if (this.#batches.size + this.#inFlight >= this.limit) throw new Error('Too many pending batches');

    // Fail early before consuming any proposal slots. Conservatively reject
    // case-only path duplicates so macOS and Linux have consistent behavior.
    const seen = new Set();
    let totalBytes = 0;
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw new Error('Invalid batch edit');
      if (typeof edit.path !== 'string' || !edit.path.trim()) throw new Error('Batch edit path required');
      const key = edit.path.replaceAll('\\', '/').normalize('NFC').toLowerCase();
      if (seen.has(key)) throw new Error('Duplicate file in batch');
      seen.add(key);
      if (typeof edit.expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(edit.expectedSha256)) {
        throw new Error('Each batch edit requires expectedSha256 from read_file');
      }
      if (typeof edit.proposedContent !== 'string') throw new Error('Each edit needs proposedContent');
      totalBytes += Buffer.byteLength(edit.proposedContent, 'utf8');
      if (totalBytes > MAX_BATCH_CONTENT_BYTES) throw new Error('Batch proposed content exceeds 256 KiB');
      if (edit.rationale !== undefined && (typeof edit.rationale !== 'string' || edit.rationale.length > 2000)) {
        throw new Error('Invalid edit rationale');
      }
    }

    this.#inFlight += 1;
    const created = [];
    try {
      for (const edit of edits) {
        const proposal = await this.proposals.proposeEdit({ ...edit, rationale: edit.rationale ?? rationale });
        created.push(proposal);
      }
      // Recheck after staging: a file may have changed while other files were
      // being inspected. This is not a substitute for rechecking on apply.
      const checks = await Promise.all(created.map((proposal) => this.proposals.checkProposal(proposal.id)));
      if (checks.some((check) => !check.fresh)) throw new Error('Stale batch: source changed during proposal creation');

      const batch = Object.freeze({
        schemaVersion: 1,
        id: randomUUID(),
        status: 'pending',
        createdAt: new Date().toISOString(),
        rationale,
        proposals: Object.freeze(created.map((proposal) => Object.freeze({ ...proposal }))),
      });
      this.#batches.set(batch.id, batch);
      return this.getBatch(batch.id);
    } catch (error) {
      // All-or-nothing storage: no half-created batch or orphan proposals.
      for (const proposal of created) this.proposals.discard(proposal.id);
      throw error;
    } finally {
      this.#inFlight -= 1;
    }
  }

  #requireBatch(id) {
    const batch = this.#batches.get(id);
    if (!batch) throw new Error('Batch not found');
    return batch;
  }

  getBatch(id) {
    const batch = this.#requireBatch(id);
    return {
      schemaVersion: batch.schemaVersion,
      id: batch.id,
      status: batch.status,
      createdAt: batch.createdAt,
      rationale: batch.rationale,
      fileCount: batch.proposals.length,
      // Only summaries; use existing get_proposal(id) for complete file diffs.
      proposals: batch.proposals.map((proposal) => ({ ...proposal })),
    };
  }

  async checkBatch(id) {
    const batch = this.#requireBatch(id);
    const results = await Promise.all(batch.proposals.map(async (proposal) => {
      try {
        return await this.proposals.checkProposal(proposal.id);
      } catch (error) {
        return { id: proposal.id, path: proposal.path, fresh: false, reason: error.message };
      }
    }));
    return {
      id: batch.id,
      fileCount: results.length,
      fresh: results.every((result) => result.fresh === true),
      results,
    };
  }

  discardBatch(id) {
    const batch = this.#requireBatch(id);
    this.#batches.delete(id);
    for (const proposal of batch.proposals) this.proposals.discard(proposal.id);
    return { id, discarded: true };
  }
}
