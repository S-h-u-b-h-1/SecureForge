# SecureForge

> **Status: TrueForge editor integration, safe batch review and controlled security verification.**

SecureForge is a security-first VS Code coding assistant powered by local **TrueForge**. The extension supports live proposal delivery, per-hunk review for existing-file batches, guarded apply/Undo, separately approved verification commands, cancellation, read-only security candidates, a controlled repair lab and exported Patch Passports. Build, Defend and Prove share the existing v1 proposal and batch contracts.

Local verification includes real VS Code editor tests and actual TrueForge runtime/SDK/MCP sessions using a deterministic local inference fixture. Configure your own model in TrueForge for production-model verification. Official competition Tasks A/B/C remain release acceptance work.

## Contributors and responsibility

- **Shubhaang Kataruka — Build:** TrueForge sessions, coding agent, source retrieval, edit proposals and core integration.
- **Aditya Ranjan — Defend/Prove:** approval UI, path and tool security audit, verification, cancellation integrity and security review.
- **Joint:** shared contracts, integration, mandatory competition tasks and release checks.

## Quickstart (no VS Code CLI required)

```bash
# In the repository root:
node --version               # Node >=22.14
npm ci
npm run check
npm test
npm run demo:inspect -- "SecureForge"
```

To use an actual model, start TrueForge separately using `npx @truefoundry/trueforge@0.183.0` and configure a model in its local dashboard at `http://localhost:8790`. For the SDK client, run `npm install`, then:

```bash
# Terminal 1, from the repository you want to inspect:
SECUREFORGE_WORKSPACE="$PWD" npm run start:mcp

# In TrueForge Settings -> Connectors, add a no-auth remote MCP server:
# name = secureforge-workspace
# URL  = http://127.0.0.1:8792/mcp

# Terminal 2, set the exact model FQN shown in TrueForge's Models settings.
SECUREFORGE_MODEL='your-configured-provider/model' \
SECUREFORGE_MCP_NAME='secureforge-workspace' \
npm run demo:agent -- 'Find the relevant source, propose a minimal README improvement, and do not apply it'
```

TrueForge standalone runtime **0.183.0** has been verified locally with the configured Muse Spark 1.3 model and SecureForge MCP connector (`npx @truefoundry/trueforge@0.183.0`). The SDK remains pinned to **0.182.0**. Current real-model generation, saved-output tests, editor API checks and limitations are recorded in [the live qualification report](outputs/live-model-qualification.json). Harness approvals and deterministic fixtures are identified separately from interactive editor acceptance.

`SECUREFORGE_MODEL` and `SECUREFORGE_MCP_NAME` are environment variables; don't commit real credentials. For local TrueForge with no login, no API key is needed **for the TrueForge SDK itself**, but your configured model provider may require one. TrueForge local mode has no login: never expose it or the MCP bridge to the public internet.

Real-model requests are **not tested by CI** because they require a locally configured TrueForge server and provider. `npm run test:wire` instead checks complete bounded source delivery, preloaded tool schemas, staging approvals and compact patch transport through a real local runtime with deterministic inference. Official recording and portal submission remain separate from automated qualification.

## Tool guarantees (current implementation)

- `read_file` — bounded line-numbered source content with SHA-256; deny secret-like names, binaries, oversized files and symlinks.
- `search_workspace` — bounded literal repository search with line evidence; no code execution.
- `lookup_symbol` — lexical candidate lookup; **not** a full AST/symbol resolver.
- `propose_edit` — stores full proposed content in process memory, requiring the expected SHA-256; **never writes source files**.
- `get_proposal` and `check_proposal` — recover a proposal for UI display and detect stale bases.

Known limitations: Linux workspace reads require `/proc/self/fd` and macOS reads use `O_NOFOLLOW_ANY` (test macOS support before relying on it); proposal persistence and production-model editor verification remain pending; no full symbol analysis; verification uses the editor-approved runner; automatic model fallback remains pending; no full MCP interoperability suite yet; best-effort secret redaction is not a DLP guarantee. Reading is blocked for symlinks, including internal symlinks, to fail closed. The bridge is for local development only.

See [Architecture and integration contract](docs/ARCHITECTURE.md) for the handoff with Aditya. Please don't merge to `main` without review and clean-clone tests.

## Local hunk review extension

The security branch includes a VS Code review milestone for pending v1 proposals. It supports independent hunk decisions, guarded editor-buffer application and native Undo. Run `npm ci`, open this repository in VS Code, press F5 and choose **Run SecureForge Review**. Then run **SecureForge: Open Two-Hunk Review Demo** in the development host. See [review setup and limitations](docs/REVIEW.md). Live delivery uses a temporary authenticated MCP connector, SDK session streaming and explicit staging approval. It has been verified against runtime 0.183.0 using a deterministic local inference fixture. Production-model verification requires a configured provider.

## Security workflow and evidence

Use **SecureForge: Security Review** for bounded read-only candidate findings. **Start Owned Security Lab** demonstrates an explicit reviewed repair with failing-before/passing-after regressions. **Export Patch Passport** records patch decisions, command receipts, finding confidence and remaining uncertainties. See [security workflow and supported scope](docs/SECURITY_WORKFLOW.md).

## Round 1 deliverables

Installable VSIX, bounded task context, inline-selection guard and agent panel are included in this branch. Follow [Round 1 readiness and recording plan](docs/ROUND1_READINESS.md) for setup, model configuration, official-task rehearsal evidence and remaining submission gates. The write-up PDF is a readiness draft. Live-model A/B, the official video and portal submission remain pending.
