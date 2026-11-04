#!/usr/bin/env node
import { Workspace } from './workspace.mjs';
import { createTrueForgeClient, runAgentTurn } from './agent.mjs';

const [command, ...args] = process.argv.slice(2);
const root = process.env.SECUREFORGE_WORKSPACE ?? process.cwd();

async function main() {
  if (command === 'inspect') {
    const workspace = await new Workspace(root).init();
    const term = args.join(' ').trim();
    if (!term) throw new Error('Provide a search term: npm run demo:inspect -- "login"');
    console.log(JSON.stringify(await workspace.searchWorkspace(term), null, 2));
    return;
  }
  if (command === 'agent') {
    const model = process.env.SECUREFORGE_MODEL;
    const task = args.join(' ').trim();
    if (!model || model.includes('replace-with')) throw new Error('Set SECUREFORGE_MODEL to an actual configured TrueForge model');
    if (!task) throw new Error('Provide a task: npm run demo:agent -- "Inspect README and propose an improvement"');
    const client = await createTrueForgeClient({
      baseUrl: process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790',
      token: process.env.TRUEFORGE_TOKEN,
    });
    const result = await runAgentTurn({
      client, model, task, mcpServerName: process.env.SECUREFORGE_MCP_NAME,
      onEvent(event) {
        if (event.type === 'model.message.delta' && (!event.threadId || event.threadId === 'main')) {
          process.stdout.write(event.content ?? '');
        }
        if (event.type === 'tool.approval_required') {
          process.stderr.write('\n[Approval required: resume this turn in the TrueForge UI. No automatic approval.]\n');
        }
        if (event.type === 'turn.done') process.stdout.write(`\n[TrueForge: ${event.state?.status ?? 'unknown'}]\n`);
      },
    });
    console.error(`Session: ${result.sessionId}`);
    if (result.state?.status !== 'done') process.exitCode = 1;
    return;
  }
  console.log('Usage: node src/cli.mjs inspect <term> | agent <task>');
  process.exitCode = 2;
}

main().catch((error) => {
  console.error('SecureForge:', error.message);
  process.exitCode = 1;
});
