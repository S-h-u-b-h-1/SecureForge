# SecureForge — Release and merge qualification

**Scope:** VS Code sidebar coding agent and guarded proposal/review workflow.
This is a checklist, not a claim that the full real-model acceptance test passed.

## Merge order

These pull requests form an intentional dependency stack:

1. [#8](https://github.com/S-h-u-b-h-1/SecureForge/pull/8) — guided Build and workspace confirmation; base `main`.
2. [#9](https://github.com/S-h-u-b-h-1/SecureForge/pull/9) — native sidebar; initially based on #8.
3. [#10](https://github.com/S-h-u-b-h-1/SecureForge/pull/10) — minimal secondary-sidebar chat; initially based on #9.
4. [#11](https://github.com/S-h-u-b-h-1/SecureForge/pull/11) — runtime/verification outcome reliability; initially based on #10.
5. [#12](https://github.com/S-h-u-b-h-1/SecureForge/pull/12) — wrong-repository fail-fast and recent-projects handoff; initially based on #11.
6. Release editor/CI qualification — this branch, initially based on #12.

**Do not merge the stack all at once.** After each preceding PR merges, retarget the next PR to `main`; inspect its changed files/diff against `main`; require fresh passing checks before merging. **Use merge commits to preserve ancestry for this stack.** Squashing a parent PR changes its commit identity and can make downstream PRs show previously reviewed changes again; if squash is required, first rebase each downstream branch carefully onto updated `main` and re-qualify it. Never force-push a shared branch without checking the affected PRs.

## Required automated checks

Run against the same candidate commit:

```bash
npm ci
npm run check
npm test
npm run package:extension
```

GitHub Actions should run Linux/Node 22 and macOS/Node 26 on PRs, with **zero failures**, and package a Linux VSIX candidate whose manifest, bundled extension and sidebar icon exist. The workflow's uploaded VSIX artifact is a candidate, not production certification. Re-run if the head commit changes.

## Required actual VS Code checks (Mac)

In a fresh VS Code window with the development extension activated:

```bash
npm run test:editor
```

This must pass sidebar command activation/focus, reviewed editor changes, multi-file atomic review, undo, stale-content refusal and no source changes before acceptance. The test uses an isolated VS Code profile. If desktop VS Code is unavailable, the gate remains **unverified**, not skipped.

For the actual packaged VSIX: use VS Code's **Install from VSIX…** and reload the window. Open SecureForge on the right. Verify its logo and composer, file/symbol attachment, sending, Stop, and no automatic disk writes. The view must not be an editor tab.

## Required live model + Flask acceptance (not covered by CI)

Use the existing pinned Flask checkout (`22d924701a6ae2e4cd01e9a15bbaf3946094af65`) with a clean Git working tree. The pre-fix Flask baseline was 90 passing and 3 skipped tests after installing the async extra; do not confuse this with SecureForge's npm suite.

- In a Node-only repo like AwaazGraph, the Flask environment-variable request must stop before contacting TrueForge, identify the current project, and offer **Recent projects** / **Browse folders**. No proposals and no changes.
- Open the correct Flask checkout in VS Code. Confirm the sidebar displays the Flask working folder.
- Ask SecureForge to treat `FLASK_DEBUG` and `FLASK_SKIP_DOTENV` values `off` and `n` as false-like (case-insensitively), adding regression tests while retaining defaults.
- Confirm the live model uses discovery, a complete source bundle, and hashed, staged proposals. The **Review** window must display only relevant files/hunks; do not accept edits silently.
- After human review, apply selected hunks and save intentionally. Exercise the sidebar's **Run tests (save files first)** action, selecting **both** `tests/test_helpers.py` and `tests/test_cli.py`. The extension must show the exact local command for approval, use `.venv` Python, return a real passing receipt, and report the result in chat. Independently verify `PYTHONPATH="$PWD/src" .venv/bin/python -m pytest tests/test_helpers.py tests/test_cli.py -q`, `git diff --check`, the exact Task A assertions, and `git diff`.
- A run ending with `noProposal`, `ITERATION_LIMIT`, cancelled, or only narrative text is **not** a qualifying model-driven patch success.

Optional deterministic TrueForge bridge qualification (local runtime required):

```bash
npm run test:editor:wire
```

That fixture verifies the real TrueForge SDK/runtime transport with deterministic local inference, **not** full quality of a paid or live model.

## Release decision

- **Automated gate:** all CI jobs and VSIX package checks green for exact head.
- **Editor gate:** `test:editor` and installed-VSIX smoke test passed.
- **Live model gate:** project selection → model call → staged review → user-approved editor changes → explicit save → regression test passed.
- **Security gate:** credential filtering, approved-tool bounds, and no uncontrolled repository writes remain intact.
- **Human gate:** maintainer inspects patch and explicitly chooses merge.

Keep draft status until the gates relevant to that PR are met. Do not state that a green unit suite proves a real model task succeeded. Do not commit generated `outputs/*.vsix` binaries.
