# SecureForge

> **Status: Core-agent foundation — not a finished VS Code extension.**

SecureForge is a security-first AI coding assistant built around **TrueForge**. The long-term product has Build, Security Review and Verify workflows with human-controlled edit approval. This repository currently contains the first independently testable Build foundation: local workspace tools, in-memory patch proposals, a small MCP HTTP bridge, a TrueForge SDK client, and regression tests. There is **no automatic source-file write** or command-execution tool.

## Contributors and responsibility

- **Shubhaang Kataruka — Build:** TrueForge sessions, coding agent, source retrieval, edit proposals and core integration.
- **Aditya Ranjan — Defend/Prove:** approval UI, path and tool security audit, verification, cancellation integrity and security review.
- **Joint:** shared contracts, integration, mandatory competition tasks and release checks.

## Quickstart (no VS Code CLI required)

```bash
# In the repository root:
node --version               # Node >=22.14
npm run check
npm test
npm run demo:inspect -- "SecureForge"
```

To use an actual model, start TrueForge separately using `npx @truefoundry/trueforge@latest` and configure a model in its local dashboard at `http://localhost:8790`. For the SDK client, run `npm install`, then:

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

Pin TrueForge runtime to **0.182.0** to match the tested SDK interface (`npx @truefoundry/trueforge@0.182.0`). The local model handshake is still unverified.

`SECUREFORGE_MODEL` and `SECUREFORGE_MCP_NAME` are environment variables; don't commit real credentials. For local TrueForge with no login, no API key is needed **for the TrueForge SDK itself**, but your configured model provider may require one. TrueForge local mode has no login: never expose it or the MCP bridge to the public internet.

The model request is **not tested by CI** because it requires a locally configured TrueForge server and model. A successful model call must be verified using the TrueForge session trace. This milestone is not Task A/B/C completion.

## Tool guarantees (current implementation)

- `read_file` — bounded line-numbered source content with SHA-256; deny secret-like names, binaries, oversized files and symlinks.
- `search_workspace` — bounded literal repository search with line evidence; no code execution.
- `lookup_symbol` — lexical candidate lookup; **not** a full AST/symbol resolver.
- `propose_edit` — stores full proposed content in process memory, requiring the expected SHA-256; **never writes source files**.
- `get_proposal` and `check_proposal` — recover a proposal for UI display and detect stale bases.

Known limitations: no persistence or diff hunk application; no full symbol analysis; no command execution/verification; no model fallback; no full MCP interoperability suite yet; best-effort secret redaction is not a DLP guarantee. Reading is blocked for symlinks, including internal symlinks, to fail closed. The bridge is for local development only.

See [Architecture and integration contract](docs/ARCHITECTURE.md) for the handoff with Aditya. Please don't merge to `main` without review and clean-clone tests.
