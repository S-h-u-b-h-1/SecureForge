# SecureForge v0.1 — Build foundation and role handoff

## Current pipeline

```text
User task (CLI; future VS Code editor)
  -> TrueForge SDK session / turn stream (configured model in TrueForge)
  -> registered local SecureForge MCP connector
  -> read_file / search_workspace / lookup_symbol (bounded, no writes)
  -> propose_edit (pending proposal in process memory, SHA-256 base check)
  -> human review (future Aditya-owned layer)
```

TrueForge is **always** the model/agent runtime. SecureForge does not call model providers directly.

## Shared data contract (v1)

`read_file` output:

```json
{"path":"src/main.py","sha256":"64-character hex digest","startLine":1,"endLine":20,"totalLines":100,"truncated":true,"redacted":false,"lines":[{"line":1,"text":"..."}]}
```

`propose_edit` input:

```json
{"path":"src/main.py","expectedSha256":"64-character hex digest","proposedContent":"complete replacement file text","rationale":"Why this change is needed"}
```

`propose_edit` output: `{schemaVersion:1,id,path,baseSha256,proposedSha256,rationale,createdAt,status,originalBytes,proposedBytes}`. `get_proposal` returns the complete `originalContent` and `proposedContent` for a diff UI. `check_proposal` returns `{id,path,fresh,expectedSha256,currentSha256}` when the file is still readable.

**Important:** Proposal creation is not approval. Neither the TrueForge SDK nor MCP tools apply the edit. The future VS Code approval engine must validate workspace ownership, compare the current document SHA-256 (and editor version), show hunk-level Accept/Reject, then apply **accepted hunks only** with `WorkspaceEdit`. The separate tool approval flag on `propose_edit` does not replace hunk approval.

## Current security boundaries

- MCP listener binds to `127.0.0.1` and rejects non-local `Origin` values.
- Only workspace-relative paths; no symlink components, traversal, binary content or known credential files.
- Maximum file size is 256 KiB; search and returned lines are bounded. These are **byte/character bounds**, not exact token budgets.
- Best-effort secret redaction; a repository may contain secrets in unexpected formats. Proposals against files where our redactor masks content are blocked to avoid deleting credential literals. Never assume model-safe data classification.
- No arbitrary shell runner, Git write tool, filesystem write tool or remote deployment tool.
- The MCP bridge is a minimal local Streamable HTTP JSON-RPC implementation for the `2025-06-18` request/response subset; add official MCP SDK compatibility tests before claiming full interoperability.

## Division and next integration gates

| Gate | Owner | Acceptance evidence |
|---|---|---|
| Model event stream | Shubhaang | Real TrueForge `sessionId` + terminal `turn.done` |
| Safe read/search/symbol | Shubhaang (Aditya security review) | Unit tests, tool-call trace, no secrets surfaced |
| In-memory edit proposal | Shubhaang | Hash-based stale rejection; unchanged source tree |
| Hunk approval and undo | Aditya | Mixed accept/reject, stale defense, editor undo |
| Security review | Aditya | Owned vulnerable fixture and safe negative control |
| Competition A/B/C | Both | Verbatim official prompts and prescribed checks |

Do not claim competition tasks complete based on unit tests alone. The official PDF and live editor acceptance are still needed.
