# Round 1 readiness

## Evidence boundaries

SecureForge has local automated editor and TrueForge integration evidence. Runtime tests use a deterministic inference fixture. The production-model catalog returned an empty list on 4 November 2026. Production-model Tasks A and B, the official editor recording, and portal submission remain pending. The reference Flask changes were manually specified for rehearsal.

The repository is public. Team name, Team ID and both members' college or employer still need confirmation. The PDF is a readiness draft with those fields visibly pending.

## Install from a clean clone

Use Node.js 22.14 or later and desktop VS Code. Work on `feat/security-engine`.

```bash
npm ci
npm run check
npm test
npm run package:extension
code --install-extension outputs/SecureForge-0.1.0.vsix
```

Start the tested local TrueForge runtime with an exact loopback allowlist for the temporary MCP connector.

```bash
HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@0.183.0
```

Configure a provider and model in TrueForge Settings, then copy the exact model FQN into VS Code settings using `examples/secureforge-settings.json`. Credentials belong in TrueForge. The extension uses its SDK and has no direct provider client. `src/agent.mjs` is the executable agent definition. `examples/agent-spec.json` illustrates its serializable shape. Live runs substitute a temporary authenticated MCP connector and enable separately approved verification.

Run **SecureForge: Open Agent Panel**. The panel supports tasks, file/symbol attachments, selected-context evidence, streamed activity and cancellation. **Preview Task Context** exposes retrieval without a model. Select saved code and use **Inline Edit Selection** for a scoped edit. Inline proposals must preserve code outside the selection. All returned edits use per-hunk review and guarded Undo.

## Context strategy

Lexical retrieval scores filenames and matching source lines. Related tests and documentation receive a bonus. Explicit `@file:path`, quoted file paths and `@symbol:name` mentions receive priority. Selection context uses the selected file. At most 12 excerpts enter automatic context. The default serialized-source budget is 24,000 UTF-8 bytes, configurable from 2,000 to 96,000. Reads scan at most 4 MiB and 2,500 candidate files. Token estimates use bytes divided by three and are approximate. Paths containing recognized credentials are excluded before reads and omitted from mentions and diagnostics. Entire source files are skipped when credential redaction would change their contents, including explicit attachments. This also excludes synthetic credential fixtures. Runs reject credential-bearing task text and inline-selection paths before contacting TrueForge. The agent can retrieve additional bounded excerpts through MCP tools. Shubhaang's integrated `discover_repository` tool adds independently bounded ranking and literal import relationships, using at most 160 files and 12 results by default. Discovery tasks are limited to 400 characters.

Paths, line ranges, SHA-256 hashes, reasons and byte usage are shown before generation. Repository excerpts are marked untrusted. Retrieval does not resolve AST symbols, callers or dependency graphs.

## Reproduce the Flask reference rehearsal

Use a disposable checkout. The script requires the official Flask revision and a clean working tree before applying reference changes.

```bash
git clone --branch 3.1.3 --depth 1 https://github.com/pallets/flask.git .tmp/flask-3.1.3
python3 -m venv .tmp/flask-venv
.tmp/flask-venv/bin/python -m pip install -e '.tmp/flask-3.1.3[async,dotenv]' 'pytest>=8,<9' greenlet
.tmp/flask-venv/bin/python scripts/flask-rehearsal.py \
  --checkout .tmp/flask-3.1.3 \
  --python "$PWD/.tmp/flask-venv/bin/python" \
  --output "$PWD/outputs/flask-rehearsal"
node scripts/flask-context-check.mjs .tmp/flask-3.1.3
```

Flask 3.1.3 resolves to `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. The tested rehearsal used Python 3.12.14 and pytest 8.x. Pytest 9 cannot collect this pinned Flask test suite because it removed an internal import used upstream.

Reference results include Task A false values, Task B masked JSON, command registration, documentation, 59 CLI tests, source/doc retrieval with credential-bearing test fixtures excluded, and an actual SDK unreachable-endpoint failure with unchanged tracked-file hashes and Git status. Reference proposals and patch are provided for inspection. They do not establish autonomous Task B discovery or official scorecard success. The included Flask BSD license covers the reference excerpts.

## Official recording plan

Target a maximum of four minutes. These intervals are planning targets. Replace every pending scorecard timestamp with an actual time from the finished recording.

1. Approximately 0:00-0:55. Task A on a clean pinned Flask checkout. Select `get_debug_flag`, enter the exact prompt, show streaming, separate hunk decisions, apply, save, verify `FLASK_DEBUG=off` and undo.
2. Approximately 0:55-2:55. Task B. Enter the exact official task without naming implementation/test/doc files. Show chosen context and reasons, the TrueForge session, staged edits in at least three files, per-hunk decisions, Save and actual CLI/test output.
3. Approximately 2:55-3:45. Task C. Use an unreachable local TrueForge endpoint, repeat A, show responsive editor, clear failure and unchanged Git status.
4. Approximately 3:45-4:00. Show repository and evidence links. Confirm all three tasks appeared in order and verification is legible.

The reference rehearsal is separate from this recording. The exact A/B prompts are preserved in `scripts/flask-rehearsal.py` and its JSON report.

## Remaining acceptance gates

- Configure a real model, then run official A and B through the installed extension.
- Confirm inline editor workflow and cancellation on a real generation. Automated checks validate proposal scope and cancellation safety.
- Record the complete A/B/C sequence and publish a viewable video link.
- Enter team metadata, model name, real provider usage/cost and actual video timestamps in the PDF.
- Review the draft PR, run clean-clone checks, and complete human merge review.
- Submit public repository, final 1-3 page PDF and video through the competition portal before the brief's deadline of 20 November 2026, 23:59 IST.

Automatic fallback, retry/backoff and a demonstrated TrueForge context-engineering feature remain future work. Current failure handling stops cleanly and preserves workspace state. The scorecard draft does not award those higher anchors.


## Source audit follow-up

The quick source audit added shared credential-path exclusion, matching search results against already-redacted text, MCP cancellation gates before dispatch and result delivery, and descriptor-bound proposal import with a 4 MiB actual-read cap. Five regression tests were added. Independent source reviewers accepted the fixes.

The audit itself was source-only. Subsequent user-requested development verification passes 94 automated tests and 15 editor/runtime checks, including the five audit regressions. Runtime handoff uses a deterministic inference fixture. A normal Build-command regression also checks delivery into review using fixture editor surfaces. The rebuilt VSIX and installation hash are recorded in `outputs/verification-summary.json`. Pre-fix audit leads retain their original needs-validation classification, since development checks validate the fixed source.

Task C now has a real packaged-editor check on the clean pinned Flask checkout. It submits the exact Task A prompt against an unreachable local TrueForge endpoint, observes the clear error, completes an editor cursor command while Build is pending, and verifies unchanged source hashes, clean Git status and saved buffers. Evidence is in `outputs/task-c-editor-check.json`. This automated check is separate from the official A/B/C recording.

The real-model catalog remains empty. Production-model A/B, real-generation inline editing and cancellation remain blocked by model availability. The technical follow-up closes directory-traversal work budgets, command-descendant cancellation lifecycle and MCP schema/dispatcher agreement with bounded implementations and regression tests.


## Combined Build / Defend / Prove baseline

The isolated `feat/secureforge-integration` worktree integrates the B2 complete-source reader from PR #5. The MCP tool is read-only, accepts 1-4 canonical existing paths and rejects partial, over-budget or credential-bearing bundles. The agent explicitly enables it and retains a 30-iteration limit. Iteration exhaustion now reports the session and terminal status with bounded tool counts and source hashes. See `docs/BUILD_SOURCE_BUNDLE.md` for the integration evidence and remaining real-model gate.

PR #5's previously cancelled macOS job was rerun successfully. Both of its CI jobs now pass. Real Muse A/B and real-generation inline/cancellation checks were explicitly deferred by the user. Final video and submission remain pending that qualification.


## Deferred technical checks completed

Directory enumeration uses a streaming directory iterator with at most 20,000 visited entries and 1,000 discovered directories per scan. Optional lower internal budgets support focused callers. Listing/search propagate cancellation and fail with a clear budget error instead of returning a misleading complete result.

Command cancellation and timeout retain process-group SIGKILL escalation after 500 ms even when the leader closes first. The receipt resolves after the close and escalation phases. Owned fixtures verify descendants that ignore SIGTERM for both cancellation and timeout. Cleanup applies to the same POSIX process group. Approved repository tests retain local-user authority.

MCP dispatch now validates the bridge's advertised object/array/string/integer schema subset, required fields, extra fields, ranges, patterns, enums and uniqueness before invoking a handler. Errors omit argument values and unexpected field names. JSON-RPC identifier validation rejects malformed envelopes. Shared reader and proposal checks remain the final resource and version controls.

The latest combined suite has 94 passing automated tests. Packaged editor/runtime checks and installed-bundle identity are recorded in `outputs/verification-summary.json`. Real-model qualification remains deferred by the user.
