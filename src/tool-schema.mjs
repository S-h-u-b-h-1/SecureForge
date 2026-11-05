// Validate the schema subset used by the bridge's fixed tool definitions.
// Input values and unknown property names never enter error messages.
export function validateToolArguments(schema, value, location = 'arguments') {
  const fail = reason => { throw new Error(`Invalid tool arguments at ${location} (${reason})`); };
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail('required field missing');
    }
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) fail('unexpected field');
        continue;
      }
      validateToolArguments(properties[key], child, `${location}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('expected array');
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('too many items');
    for (let index = 0; index < value.length; index++) validateToolArguments(schema.items, value[index], `${location}[${index}]`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('duplicate items');
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') fail('expected string');
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) fail('string too short');
    if (schema.maxLength !== undefined && length > schema.maxLength) fail('string too long');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('pattern mismatch');
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) fail('expected integer');
    if (schema.minimum !== undefined && value < schema.minimum) fail('below minimum');
    if (schema.maximum !== undefined && value > schema.maximum) fail('above maximum');
  } else {
    fail('unsupported schema type');
  }
  if (schema.enum && !schema.enum.includes(value)) fail('unsupported value');
}
