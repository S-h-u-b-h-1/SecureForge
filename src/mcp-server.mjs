#!/usr/bin/env node
import http from 'node:http';
import { Workspace } from './workspace.mjs';
import { ProposalStore } from './proposals.mjs';
import { BatchProposalStore } from './build/batches.mjs';

const TOOLS = [
  { name: 'read_file', description: 'Read bounded numbered lines from a permitted workspace file. Returns SHA-256 for version-aware proposals.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, maxLines: { type: 'integer' } }, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'search_workspace', description: 'Find literal text matches across permitted repository files. Never executes repository code.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'integer' } }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'lookup_symbol', description: 'Lexical candidate lookup for a symbol; results are not verified AST definitions.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'propose_edit', description: 'Create an UNAPPLIED in-memory full-file edit proposal. Does not write any source file. Requires a SHA-256 from read_file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, expectedSha256: { type: 'string' }, proposedContent: { type: 'string' }, rationale: { type: 'string' } }, required: ['path', 'expectedSha256', 'proposedContent'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'get_proposal', description: 'Retrieve a pending in-memory edit proposal for user review (not approval).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'check_proposal', description: 'Check whether an in-memory edit proposal is stale against current disk content.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'propose_batch', description: 'Stage 2..8 coordinated UNAPPLIED file edit proposals atomically. Requires each original SHA-256. No source file writes.',
    inputSchema: { type: 'object', properties: {
      edits: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'object', properties: {
        path: { type: 'string' }, expectedSha256: { type: 'string' }, proposedContent: { type: 'string' }, rationale: { type: 'string' },
      }, required: ['path', 'expectedSha256', 'proposedContent'], additionalProperties: false } },
      rationale: { type: 'string' },
    }, required: ['edits'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'get_batch', description: 'Return a pending batch with the existing v1 proposal IDs; no file contents or approval decisions.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'check_batch', description: 'Recheck every underlying file SHA-256; never authorizes applying a patch.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
];

export async function createMcpServer({ root, port = 8792, host = '127.0.0.1' }) {
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('MCP bridge must bind to loopback');
  const workspace = await new Workspace(root).init();
  const proposals = new ProposalStore(workspace);
  const batches = new BatchProposalStore(proposals);
  const commands = {
    read_file: (p) => workspace.readFile(p.path, { startLine: p.startLine, maxLines: p.maxLines }),
    search_workspace: (p) => workspace.searchWorkspace(p.query, { maxResults: p.maxResults }),
    lookup_symbol: (p) => workspace.lookupSymbol(p.symbol),
    propose_edit: (p) => proposals.proposeEdit(p),
    get_proposal: (p) => proposals.getProposal(p.id),
    check_proposal: (p) => proposals.checkProposal(p.id),
    propose_batch: (p) => batches.proposeBatch(p),
    get_batch: (p) => batches.getBatch(p.id),
    check_batch: (p) => batches.checkBatch(p.id),
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    // Origin validation helps prevent browser-based DNS rebinding; host is loopback only.
    const origin = req.headers.origin;
    if (origin) {
      try {
        const u = new URL(origin);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return send(403, { error: 'Origin not allowed' });
      } catch { return send(403, { error: 'Origin not allowed' }); }
    }
    if (req.url === '/health' && req.method === 'GET') return send(200, { status: 'ok', root: '(private)' });
    if (req.url !== '/mcp' || req.method !== 'POST') return send(405, { error: 'Use POST /mcp' });
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) return send(415, { error: 'JSON required' });
    const chunks = [];
    let byteCount = 0;
    try {
      for await (const chunk of req) {
        byteCount += chunk.length;
        if (byteCount > 320 * 1024) return send(413, { error: 'MCP request too large' });
        chunks.push(chunk);
      }
      // Buffer chunks are arbitrary transport boundaries, not UTF-8 character
      // boundaries. Decode once after the bounded body has been assembled.
      const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, byteCount));
      const message = JSON.parse(body);
      if (message.jsonrpc !== '2.0' || !message.method || typeof message.method !== 'string') {
        return send(400, { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
      }
      if (!Object.hasOwn(message, 'id')) { res.writeHead(202); return res.end(); }
      const result = async () => {
        switch (message.method) {
          case 'initialize': return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'secureforge-workspace', version: '0.1.0' } };
          case 'ping': return {};
          case 'tools/list': return { tools: TOOLS };
          case 'tools/call': {
            const name = message.params?.name;
            if (!Object.hasOwn(commands, name)) throw new Error('Unknown tool');
            const params = message.params?.arguments ?? {};
            if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid arguments');
            try {
              const data = await commands[name](params);
              return { content: [{ type: 'text', text: JSON.stringify(data) }] };
            } catch (err) {
              return { isError: true, content: [{ type: 'text', text: err.message }] };
            }
          }
          default: return undefined;
        }
      };
      const value = await result();
      if (value === undefined) return send(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      return send(200, { jsonrpc: '2.0', id: message.id, result: value });
    } catch (err) {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC payload' } });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, workspace, proposals, batches, address: server.address() };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  createMcpServer({
    root: process.env.SECUREFORGE_WORKSPACE ?? process.cwd(),
    port: Number(process.env.SECUREFORGE_MCP_PORT ?? 8792),
  }).then(({ address }) => {
    console.log(`SecureForge read-only MCP bridge listening at http://127.0.0.1:${address.port}/mcp`);
    console.log('No file-write or arbitrary shell tools are exposed. Keep this local.');
  }).catch((err) => { console.error(err.message); process.exitCode = 1; });
}
