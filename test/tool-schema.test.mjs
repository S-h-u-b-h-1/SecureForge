import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArguments } from '../src/tool-schema.mjs';

const schema = { type: 'object', properties: {
  paths: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 2 } },
  limit: { type: 'integer', minimum: 1, maximum: 2 },
  executable: { type: 'string', enum: ['node'] },
}, required: ['paths'], additionalProperties: false };

test('tool schema validates nested arrays, ranges, enums and Unicode lengths', () => {
  assert.doesNotThrow(() => validateToolArguments(schema, { paths: ['🙂', 'ab'], limit: 2, executable: 'node' }));
  for (const value of [null, [], {}, { paths: [] }, { paths: ['a', 'a'] }, { paths: ['abc'] },
    { paths: ['a'], limit: 0 }, { paths: ['a'], limit: 1.5 }, { paths: ['a'], executable: 'sh' },
    { paths: ['a'], extra: true }]) {
    assert.throws(() => validateToolArguments(schema, value), /Invalid tool arguments/);
  }
});

test('schema errors omit supplied values and unexpected property names', () => {
  const token = 'ghp_abcdefghijklmnopqrstuv';
  for (const value of [{ paths: [token] }, { paths: ['a'], [token]: true }]) {
    assert.throws(() => validateToolArguments(schema, value), error => !error.message.includes(token));
  }
});
