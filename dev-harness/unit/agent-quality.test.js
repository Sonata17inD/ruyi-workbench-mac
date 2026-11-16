'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAgentJsonSchema, propagateAssignments } = require('../../ruyi-workbench/app/backend/agent-quality.cjs');
test('schema only accepts declared own properties, even for JavaScript prototype names', () => {
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  for (const name of ['__proto__', 'constructor', 'toString']) {
    const value = JSON.parse(`{"${name}":"unexpected"}`);
    assert.equal(validateAgentJsonSchema(value, schema).ok, false, name);
  }
});
test('assignment identifiers remain data and cannot change the output prototype', () => {
  const assignments = JSON.parse('{"__proto__":{"label":"value"},"constructor":"assigned"}');
  const result = propagateAssignments([{ structuredResult: { assignments, propagationEdges: [{ from: '__proto__', to: 'target' }] } }], {});
  assert.equal(result.verdict, 'pass');
  assert.equal(Object.getPrototypeOf(result.assignments), Object.prototype);
  assert.equal(Object.hasOwn(result.assignments, '__proto__'), true);
  assert.deepEqual(result.assignments.target, { label: 'value' });
  assert.equal(result.assignments.constructor, 'assigned');
  assert.equal({}.label, undefined);
});
