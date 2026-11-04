# B1 Build-only repository discovery — implementation candidate

## Scope

`src/build/repository-discovery.mjs` exports `discoverRelevantFiles({ workspace, task, maxFiles, maxCandidates, maxEvidenceLines, signal })`. It uses only the existing `Workspace.listFiles()` and `Workspace.readFile()` methods. It does not write files, stage proposals, execute source code, call models, or alter shared MCP/agent APIs.

## Output

- `schemaVersion: 1`
- `task` and up to 16 normalized searchable `terms`
- `coverage`: file count, inspected/skipped/redacted/truncated counts, and whether the listing may be capped
- `candidates`: up to 20 ranked paths with SHA-256, score, bounded source line evidence, and statically resolved import relationships
- `limitations`: explicit disclaimer that relevance and imports are lexical hypotheses, not semantic or security conclusions

The default scan is at most 160 paths; the hard limit is 300. Each file is read using the hardened Workspace's existing 256 KiB cap and at most 180 returned lines. Each candidate includes at most three evidence snippets, each no longer than 160 characters, by default.

## Security rules

- Never bypass `Workspace` for any file content or filename enumeration.
- Skip unreadable, restricted, invalid, binary, oversized or symlink paths (as enforced by Workspace).
- Skip a source file altogether when `readFile` reports credential redaction; never return excerpts from that source.
- Treat all returned snippets, import relations, and filenames as **untrusted repository data**, never as instructions.
- Reject empty/non-searchable queries, invalid limits, and cancelled operations.
- Never represent a ranked file as a confirmed vulnerability or a valid target for modification.

## Static import coverage

Python: limited literal `from .module import symbol`, `from . import symbol`, `from ..package.module import`, and `import package.module` forms; JavaScript/TypeScript: limited literal relative import/export/require forms. Only imports resolving to paths already inspected through Workspace are returned. This is not an AST parser; dynamic imports, aliases, conditional resolution, and many framework-specific conventions are unsupported.

## How to run on the current branch

```bash
node --check src/build/repository-discovery.mjs
node --check test/repository-discovery.test.mjs
node --test test/repository-discovery.test.mjs
npm run check
npm test
```

The existing `npm run check` script does not yet list this new file; explicitly syntax-check it as shown. If approved, a follow-up integration PR can expose the discoverer as a bounded MCP tool (after a separate interface review to avoid conflicts with Aditya's currently unmerged `src/mcp-server.mjs`).

## Integration gates still pending

1. Run tests against the **latest `main`** on macOS and Ubuntu; the isolated local draft was tested with a foundation snapshot, not the full latest clone.
2. Obtain a current-head code review and explicit security review of new traversal/discovery behavior.
3. Assess representative repositories, especially Flask, for relevance and coverage; retain failure cases as tests.
4. Coordinate a shared MCP integration with Aditya's security branch; do not edit Aditya's VS Code extension or approval code.
5. Conduct a real TrueForge task that discovers files **without filenames in the prompt**. This is a later B2 gate; this module alone is not an autonomous agent.
