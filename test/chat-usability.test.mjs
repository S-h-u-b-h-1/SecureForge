import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedConversation, followupContextMessage, categorizeTrueForgeError } from '../src/chat-usability.mjs';

test('follow-up context remains bounded, redacted, and explicitly lower trust', () => {
  const history = Array.from({ length: 12 }, (_, i) => ({
    user: 'Task ' + i + ' password=hidden-value-for-test ' + 'x'.repeat(500),
    assistant: 'Reply ' + i + ' ' + 'y'.repeat(500),
    outcome: i % 2 ? 'proposal_staged' : 'no_proposal',
  }));
  const kept = boundedConversation(history);
  assert.equal(kept.length, 4);
  assert.equal(kept[0].user.startsWith('Task 8'), true);
  assert.ok(Buffer.byteLength(JSON.stringify(kept), 'utf8') <= 3400);
  assert.doesNotMatch(JSON.stringify(kept), /hidden-value-for-test/);
  const message = followupContextMessage(history);
  assert.match(message, /untrusted/);
  assert.match(message, /staged proposals/);
  assert.doesNotMatch(message, /hidden-value-for-test/);
  assert.equal(followupContextMessage([]), null);
});

test('model/runtime diagnostics provide safe actions without provider error disclosure', () => {
  const cases = [
    [{ status: 401, message: 'private-api-key' }, 'authentication', /TrueForge Settings/],
    [{ status: 429, message: 'private-api-key' }, 'rate_limit', /Retry later/],
    [{ status: 404, message: 'private-api-key' }, 'model', /Refresh Models/],
    [{ code: 'ECONNREFUSED', message: 'provider secret' }, 'connection', /localhost/],
    [{ code: 'constructor', message: 'private-api-key' }, 'runtime', /Output/],
    [{ cause: { response: { status: 403 }, message: 'provider secret' } }, 'authentication', /credentials/],
  ];
  for (const [error, expected, hint] of cases) {
    const result = categorizeTrueForgeError(error);
    assert.equal(result.kind, expected);
    assert.match(result.message, hint);
    assert.doesNotMatch(result.message, /private-api-key|provider secret/);
  }
});
