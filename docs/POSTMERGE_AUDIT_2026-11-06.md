# SecureForge — post-merge codebase audit
**Date:** 2026-11-06  
**Audited baseline:** `main` at merge commit `aaf6c3cd4c96e92a910baeec329d42a212bbaa2d` (PR #13).  
**Remediation:** PR #15 (`audit/postmerge-hardening-20261106`).  
**Decision:** The core local workflow works on the demonstrated Flask case; not every repository, model, platform or security claim is independently certified.

## What was reviewed

- **Build and model:** `src/agent.mjs`, `src/live-run.mjs`, `src/context.mjs`, `src/build/{repository-discovery,source-bundle,patch-batch,batches}.mjs`; relevant SDK/MCP tool contracts.
- **Workspace boundaries:** `src/workspace.mjs`, `src/proposals.mjs`, `src/mcp-server.mjs`, `src/tool-schema.mjs`, `src/commands.mjs`.
- **VS Code extension:** `extension/{entry,extension,agent-panel,workflows,review-ui,apply-review,security-ui}` and `extension/package.json`.
- **Review, security, evidence:** `src/{review,review-group,security,proof,passport}.mjs`, selected fixtures and corresponding unit/editor test source.
- **Build/CI/dependencies:** root and extension package manifests, `scripts/package-extension.mjs`, `.github/workflows/ci.yml`, README/release gates.

This is a targeted code-level review of the important entry points and trust boundaries, **not** a formal exhaustive audit of all execution paths or every dependency.

## Confirmed working evidence

| Gate | Evidence | Classification |
|---|---|---|
| PR #13 source/test baseline | Exactly the same file tree as merged `main`; GitHub Actions Ubuntu/Node22 and macOS/Node26: **133/133 passing** | Automated pass on merged content |
| Real model code generation | User's local TrueForge/Muse session against clean pinned Flask 3.1.3: two-file, eight-hunk **unapplied** proposal | Live pass for that task |
| Human patch approval | Eight hunks reviewed and explicitly applied into VS Code editor; initial stale state blocked changes safely | Live pass |
| Saved-file tests | Saved `src/flask/helpers.py` and `tests/test_helpers.py`; `126 passed, 3 skipped`, `git diff --check` clean | Live pass for specified tests |
| Editor host regression | Earlier local `npm run test:editor`: 12/12 checks with clean CLI exit | Local pass for tested build |
| MCP/file controls | Invalid arguments, traversal, symlinks, secret-like files and stale proposal guards have automated regression coverage | Unit-tested, not complete penetration certification |
| Security review / controlled lab | Pattern/lexical candidates plus owned regression proof; controls explicitly limit claims | Feature-level automated pass; limited scope |
| Packaged extension | CI-produced installable VSIX with manifest, bundled entrypoint, icon, docs and fixtures | Packaging pass |

## Findings identified and addressed in PR #15

**SF-AUD-01 — Verification could use stale saved files (high, correctness).**
A model or user could request verification while approved changes remained unsaved in editor buffers. The tests could pass against *old* disk bytes, misleading the user. The patch refuses verification when any open file in the selected workspace is dirty and rechecks after the user approves the exact command. It does not silently save anything or bypass the command allowlist. Regression coverage checks both initial dirtiness and edits during approval.

**SF-AUD-02 — Reserved-directory exclusions were case-sensitive (medium, security hardening).**
Direct file reads and repository listing excluded `.git`, `.venv`, `node_modules` and similar directories by case-sensitive string comparison. Mixed-case spellings are unsafe on case-insensitive volumes and undermine cross-platform policy consistency. The patch case-folds reserved-directory names and tests `.GIT`, `.VENV`, `NODE_MODULES` and `DIST` on both CI platforms.

**SF-AUD-03 — Failed MCP tools were not marked failed in activity (low, diagnosis).**
A tool failure could emit `started` but no error status in the activity stream. The patch emits sanitized `failed` metadata (tool name/status only) without exposing input, response bodies or credential details.

**SF-AUD-04 — Installed UI version ambiguity (medium, UX/validation).**
Different VSIX builds previously reused `0.1.0`; the user observed missing `Accept all hunks` despite the source containing it. The follow-up uses extension version `0.1.1` and shows the **actually loaded** version in the review window. This does not by itself prove live button behavior; a fresh installed-VSIX smoke test is still needed.

**SF-AUD-05 — CI precision / dependency check (low).**
CI now derives the VSIX artifact filename from the extension manifest, checks the patch-batch module's syntax explicitly and runs a high-severity npm advisory check on the lockfile.

## Known residual limitations (not silently certified)

1. The secret-filtering patterns are **best effort, not DLP**. Avoid attaching private repositories containing unclassified credentials to an unrestricted model.
2. `Workspace.listFiles()` still uses normal directory enumeration. Descriptor-anchored file reading is hardened, but directory-swap race safety for *listings* is not formally established.
3. Approval-gated tests execute repository code with the local user's permissions. The runner is bounded and does not use a shell, but it is **not** a sandbox.
4. The MCP server implements a bounded protocol subset, not an independently certified complete MCP implementation.
5. The agent is intentionally limited by context budgets, proposal caps and model reliability. Production quality for arbitrary projects/models is unverified.
6. CI's Node tests and packaged VSIX checks do **not** replace a real desktop VS Code host test. The current PR #15 review controls and installed version need a final Mac smoke test.
7. Review proposals are kept in process memory, not durable storage. Reloading VS Code discards the in-memory state; saved source changes remain in Git and should be checked separately.
8. Current production engine targets Linux/macOS for hardened workspace reads. Windows behavior is not verified as equivalent.

## Release decision and actions

- Keep PR #15 **draft** until exact-head CI passes on Ubuntu/macOS, the VSIX packages correctly and desktop smoke confirms the installed version, Accept All, blocked dirty-buffer verification and safe Apply/Undo.
- Do not rewrite or reset the merged `main` branch based solely on heuristic findings.
- Requalify after any new change to the verification runner or filesystem boundary.
- After PR #15 merges, the next live regression should include explicit Save, an approved test command, review status, and a failing/declined-command negative control.
