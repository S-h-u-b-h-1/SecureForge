# Hunk review milestone

This local editor milestone consumes the existing pending v1 `get_proposal` payload, including `originalContent` and `proposedContent`. It derives line-level hunks without modifying the shared agent or MCP contracts.

## Run in VS Code

1. Run `npm ci` in the repository root.
2. Open the repository root in desktop VS Code.
3. Press F5 and choose **Run SecureForge Review**.
4. In the Extension Development Host, open the command palette and run **SecureForge: Open Two-Hunk Review Demo**.
5. Accept the greeting change and reject the status change.
6. Click **Apply accepted hunks**. Only the greeting changes in the source editor buffer.
7. Focus the source editor and use native **Undo** to restore its original content. Use **Save** when you want accepted edits written to disk.

The demo uses `fixtures/review-demo.py` from the selected workspace and a synthetic proposal made through the real `ProposalStore`. It does not run a model. The review panel labels it as a local synthetic demo. Undo or restore the fixture before starting another demo if you saved edits.

## Review an agent proposal

Use **SecureForge: Review Proposal JSON** to open a locally exported full `get_proposal` response. Choose the correct workspace folder if the window contains multiple roots. A `propose_edit` summary alone is insufficient because it does not contain source and proposed text.

The extension validates the proposal's content hashes, current disk content, editor content and captured document version. It reuses the existing Workspace path/symlink restrictions. Every hunk needs an explicit decision. Applying is single-use. Closing or discarding a pending review does not apply it. Detected credentials in either source or proposed text block review. The panel inserts proposal text using DOM textContent under a nonce-based Content Security Policy.

Edits use VS Code WorkspaceEdit and native Undo. They remain unsaved until the developer saves. A stale proposal must be regenerated, even if the developer edited and later restored the original text.

## Scope and remaining integration

This is a single-existing-file review milestone. It does not support new files, multi-file transactions, TrueForge streaming into the panel, automatic proposal export, cancellation of running agents, approved command execution, or security findings. The MCP server still has no source-file write tool. Its TrueForge `propose_edit` approval remains separate from this human hunk review. Completing the competition integration requires connecting those lifecycle states.

Review bounds are 256 KiB per source/proposed text, a 250 ms diff budget, 10,000 maximum edit distance and 200 hunks. A JSON import is capped at 4 MiB. The diff dependency is pinned. Secret filtering is best effort. Filesystem restrictions cover proposal validation reads. WorkspaceEdit is an editor API, not an OS-level filesystem sandbox against another process racing a later Save.

## Verification

`npm test` includes deterministic hunk-selection and safe-apply regressions. Run `npm run test:editor` with desktop VS Code installed to exercise extension activation, accepted-only application, native Undo, Unicode/CRLF and stale-file handling in a real Extension Development Host. The runner uses an isolated VS Code profile and temporary fixtures. Reports and diagnostic profiles remain under ignored `.tmp/`. It never changes your normal VS Code profile. Set SECUREFORGE_CODE_PATH to the VS Code CLI executable if it is installed outside the default macOS location or Linux PATH. Tests currently support macOS/Linux, matching the existing Workspace implementation.

Manual UI verification also exercised the demo command, visible old/new hunk previews, Accept on the first hunk, Reject on the second, Apply and native Undo. Official Task A and live TrueForge integration are separate acceptance gates.
