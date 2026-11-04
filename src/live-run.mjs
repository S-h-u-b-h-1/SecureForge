import { randomBytes, randomUUID } from 'node:crypto';
import { createMcpServer } from './mcp-server.mjs';
import { buildAgentSpec } from './agent.mjs';
import { redactSecrets } from './workspace.mjs';

export function localTrueForgeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a local TrueForge HTTP origin without credentials');
  }
  return url.origin;
}

export class LiveRun {
  constructor({ client, root, onEvent = () => {}, approveTool = async () => false }) {
    this.client = client;
    this.root = root;
    this.onEvent = onEvent;
    this.approveTool = approveTool;
    this.controller = new AbortController();
    this.sessionId = null;
    this.state = 'idle';
    this.staged = [];
  }

  async cancel() {
    if (['cancelled', 'done', 'error'].includes(this.state)) return;
    this.state = 'cancelled';
    this.controller.abort();
    this.staged = [];
    this.onEvent({ type: 'secureforge.cancelled', content: 'Run cancelled; pending proposals discarded.' });
    if (this.sessionId) {
      try { await this.client.sessions.cancel(this.sessionId, {}, { timeoutInSeconds: 5, maxRetries: 0 }); }
      catch { this.onEvent({ type: 'secureforge.cancel_warning', content: 'Server cancellation was not confirmed. The local bridge is being closed.' }); }
    }
  }

  async run({ model, task }) {
    if (this.state !== 'idle') throw new Error('This run cannot be replayed');
    if (typeof task !== 'string' || !task.trim() || task.length > 20000) throw new Error('Task must contain 1..20000 characters');
    this.state = 'running';
    const accessToken = randomBytes(32).toString('hex');
    const name = `secureforge-${randomUUID().slice(0, 8)}`;
    const signal = this.controller.signal;
    const requestOptions = { abortSignal: signal, maxRetries: 0, timeoutInSeconds: 120 };
    let bridge;
    let registered = false;
    try {
      bridge = await createMcpServer({
        root: this.root, port: 0, accessToken,
        onProposal: proposal => { if (!signal.aborted) this.staged.push(proposal); },
      });
      signal.throwIfAborted();
      await this.client.settings.mcpServers.create({ manifest: {
        name, description: 'Temporary SecureForge workspace tools for one editor run', type: 'remote',
        url: `http://127.0.0.1:${bridge.address.port}/mcp`,
        auth: { type: 'header', headers: { Authorization: `Bearer ${accessToken}` } },
      } }, requestOptions);
      registered = true;
      const { data: session } = await this.client.sessions.create({
        agent: { spec: buildAgentSpec({ model, mcpServerName: name }) },
      }, requestOptions);
      this.sessionId = session.id;
      signal.throwIfAborted();
      this.onEvent({ type: 'secureforge.session', content: session.id });
      let input = [{ type: 'user.message', content: task }];
      for (let step = 0; step < 20; step++) {
        signal.throwIfAborted();
        let final;
        const approvals = [];
        const stream = await this.client.sessions.createTurnStream(session.id, { input }, requestOptions);
        for await (const { data: event } of stream.withMetadata()) {
          signal.throwIfAborted();
          if (event.type === 'tool.approval_required') approvals.push(event);
          if (event.type === 'turn.done') final = event.state;
          // Never render raw tool results or hidden model reasoning in activity logs.
          this.onEvent({ type: event.type, content: event.type === 'model.message.delta'
            ? redactSecrets(event.content ?? '') : '' });
        }
        if (!final) throw new Error('TrueForge stream ended without a terminal event');
        // Runtime 0.183 reports a terminal turn with required actions as "done";
        // SDK 0.182 also describes "paused". Both still require an approval turn.
        if (['paused', 'done'].includes(final.status) && approvals.length) {
          input = [];
          for (const approval of approvals) {
            for (const call of approval.toolCalls ?? approval.tool_calls ?? []) {
              const allowed = await this.approveTool({ sessionId: session.id, toolCallId: call.id });
              signal.throwIfAborted();
              input.push({ type: 'user.tool_approval', threadId: approval.threadId ?? approval.thread_id,
                toolCallId: call.id, approval: allowed ? { status: 'allow' } : { status: 'deny', reason: 'User declined staging' } });
            }
          }
          continue;
        }
        if (final.status !== 'done') throw new Error(`TrueForge run ended with ${final.status}`, { cause: final });
        const result = [];
        const seen = new Set();
        for (const staged of this.staged) {
          const proposals = staged.kind === 'batch'
            ? bridge.batches.getBatch(staged.id).proposals.map(item => bridge.proposals.getProposal(item.id))
            : [bridge.proposals.getProposal(staged.id)];
          for (const proposal of proposals) {
            if (seen.has(proposal.path)) throw new Error('Multiple proposals for one file require a new consolidated review');
            seen.add(proposal.path);
          }
          result.push(...proposals);
        }
        signal.throwIfAborted();
        this.state = 'done';
        return { id: session.id, proposals: result, sessionId: session.id };
      }
      throw new Error('Approval round limit exceeded');
    } catch (error) {
      this.staged = [];
      if (signal.aborted) {
        this.state = 'cancelled';
        if (this.sessionId) {
          try { await this.client.sessions.cancel(this.sessionId, {}, { timeoutInSeconds: 5, maxRetries: 0 }); } catch { /* Bridge shutdown prevents further tools. */ }
        }
        throw new Error('Run cancelled; no proposals were applied');
      }
      this.state = 'error';
      throw new Error(`TrueForge run failed (${error.statusCode ?? error.code ?? 'connection or model error'}). No proposals were applied.`, { cause: error });
    } finally {
      if (bridge) {
        bridge.server.closeAllConnections();
        await new Promise(resolve => bridge.server.close(resolve));
        await bridge.workspace.close();
      }
      if (registered) {
        try { await this.client.settings.mcpServers.delete(name, { timeoutInSeconds: 5, maxRetries: 0 }); }
        catch { this.onEvent({ type: 'secureforge.cleanup_warning', content: `Remove temporary connector ${name} in TrueForge Settings.` }); }
      }
    }
  }
}
