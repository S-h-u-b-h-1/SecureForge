# Build-only multi-file proposal contract (v1 additive)

This document describes the independent Build track. The existing single-file propose_edit, get_proposal and check_proposal v1 contract remains unchanged. The Defend/Prove team controls whether any edit may be applied.

## MCP tools (additive)

- propose_batch: edits is an array of 2–8 objects with path, expectedSha256 and proposedContent; per-edit and batch-wide rationale are optional. Every SHA-256 must originate from reading the file. Total proposed UTF-8 content is limited to 256 KiB, with the existing per-file limit also enforced. TrueForge tool approval stages a proposal; it is not permission to apply code.
- get_batch: returns schemaVersion, id, createdAt, status, fileCount and summaries of individual v1 proposal IDs, paths, base/proposed hashes and sizes. The existing get_proposal(id) returns full original and proposed content for the review UI.
- check_batch: returns id, fileCount, fresh and per-file checks. The batch is fresh only if every file still matches its original SHA-256.

## Transaction boundaries

### Compact exact-text transport

`propose_patch_batch` accepts 2–8 existing files with `path`, `expectedSha256` and 1–12 `replacements`. Each replacement has a nonempty `oldText` that must occur exactly once in the original source, plus `newText`. Anchors are literal text, not regex patterns. Replacements refer to the original snapshot, cannot overlap, and preserve every byte outside their ranges, including CRLF and a missing final newline. Use a unique existing context line as the anchor when inserting text.

The serialized patch request is capped at 64 KiB. Expansion uses only `Workspace.rawForProposal`; it rejects stale hashes, noncanonical/duplicate paths, symlinks, restricted sources and recognized credential-bearing source or proposed content. Detection remains best effort, not complete DLP. Cancellation before staging produces no batch. Expanded proposals retain the existing 256 KiB total content limit.

This is a transport alternative, not a new application path. Expanded full-file edits pass through the existing `BatchProposalStore`, including its rereads, rollback and final freshness checks. The result contains the same v1 proposal IDs consumed by hunk review. TrueForge staging approval, local hunk decisions, Save and command approval remain separate gates. Snapshots are not atomic across files.

Batch creation first validates all inputs and duplicate paths, then stages edits through the existing ProposalStore.proposeEdit. A failure in any edit discards previously staged proposals in the same attempt and does not create a batch ID. After staging, it rechecks all hashes. The batch exists only in process memory. No source files are modified.

A successful check_batch is a point-in-time observation, not a lock. The future approval layer must recheck on-disk hashes and editor versions immediately before applying an accepted hunk. Batch creation does not establish an atomic filesystem-wide snapshot under concurrent writers.

## Independent ownership

Build creates candidate changes and evidence only. Defend/Prove implements displaying, approving, rejecting, applying, undoing and verifying changes. No shell execution, direct file-write or apply-edit permission is introduced here. Tests exercise three-file staging, rollback, unchanged source files, stale rejection, size/path limits, secret-source rejection and MCP routing.
