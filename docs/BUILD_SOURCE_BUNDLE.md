# SecureForge B2 source-bundle candidate (Build-only)

## Problem and evidence

The real Muse Spark Task B session `01m6ktbb6enywynyf81nxnxc4s` terminated with
`You have reached iteration limit of 30, please request again`, after 31
TrueForge `call_tool` wrapper calls. The last 25 included 19 `read_file` and
6 `search_workspace` requests. This is evidence of repeated source exploration;
it is not proof that a single tool was malfunctioning.

## Design

`readSourceBundle({workspace, paths, signal})` retrieves 1–4 complete existing
sources in one bounded, **read-only** operation. The model must choose paths
after autonomous discovery; no filenames are injected into the user task.
The helper:

- Uses only the hardened `Workspace.rawForProposal` descriptor-based reader.
- Refuses sensitive filenames and entire contents matching the existing
  credential-redaction patterns; this is best effort, **not DLP**.
- Rejects traversal, symlinks and restricted paths through Workspace policy.
- Checks each returned SHA-256 against the exact UTF-8 content, and preserves
  CRLF and final newlines instead of reconstructing from truncated snippets.
- Caps the combined source content at **96 KiB** and 4 files. For the pinned
  Flask Task B targets, combined source size is approximately 74 KiB.
- Aborts on cancellation and refuses partial bundles on any failed file.
- Never applies edits, stages proposals, executes tests or calls a model.

**Important:** Successful retrieval is not approval to modify files. `propose_batch`
must recheck hashes, and the Defend/Prove layer must separately verify editor
versions and accepted hunks before applying anything. Multi-file reads are
not atomic against concurrent writers.

## Test locally

Add the source and test files into a clean, isolated Build branch based on
reviewed `main`; then run:

```bash
node --check src/build/source-bundle.mjs
node --test test/source-bundle.test.mjs
npm run check
npm test
```

## Integration handoff (NOT implemented here)

After Aditya's PR #4 is reviewed and merged, coordinate registering a new
read-only MCP tool (suggested name `read_source_bundle` with an explicit array
of 1–4 canonical relative paths) and adding it to the TrueForge `enable_tools`
list. Do not independently edit `src/mcp-server.mjs`, `src/live-run.mjs`, the
VS Code extension, the hunk approval/undo code, or security engine.

Before making the integrated tool mergeable, add an MCP round-trip test and an
actual Muse Spark Flask Task B test. Inspect the model's chosen paths, tool
calls, staged proposal hashes and clean Git state. Also verify that the model
does not loop just as much after source-bundle retrieval.

The proposed tool reduces **network/model interactions**, not total source
bytes or model inference work. Treat the initial results as a candidate, not
proven autonomous Task B success.
