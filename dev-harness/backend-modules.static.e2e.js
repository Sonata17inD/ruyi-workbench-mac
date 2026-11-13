'use strict';
// Explicit CommonJS service boundary. The legacy concatenation graph remains
// separately audited until its remaining layers are migrated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const root = path.resolve(__dirname, '../ruyi-workbench');
const base = path.join(root, 'app/backend');
const files = fs.readdirSync(base).filter(name => name.endsWith('.cjs'));
const shipped = new Set(JSON.parse(fs.readFileSync(path.join(root, 'packaging/macos/runtime-files.json'))).workbench);
const builtins = new Set(builtinModules.flatMap(name => [name, 'node:' + name]));
const graph = new Map();
for (const name of files) {
  assert.ok(shipped.has('app/backend/' + name), name + ' missing from release allowlist');
  const source = fs.readFileSync(path.join(base, name), 'utf8');
  const dependencies = [];
  for (const match of source.matchAll(/\brequire\(['"]([^'"]+)['"]\)/g)) {
    const specifier = match[1];
    if (builtins.has(specifier)) continue;
    assert.ok(specifier.startsWith('./'), name + ' may only import Node builtins or local service modules');
    const resolved = path.resolve(base, specifier);
    assert.equal(path.dirname(resolved), base, name + ' must not depend on legacy host or source layout');
    assert.ok(fs.existsSync(resolved), 'unresolved module ' + specifier);
    dependencies.push(path.basename(resolved));
  }
  graph.set(name, dependencies);
}
const visiting = new Set(), visited = new Set();
function visit(name) {
  assert.ok(!visiting.has(name), 'cyclic explicit service dependency: ' + [...visiting, name].join(' -> '));
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of graph.get(name) || []) visit(dependency);
  visiting.delete(name); visited.add(name);
}
for (const name of files) visit(name);
console.log(`BACKEND MODULES STATIC E2E: ALL PASS (${files.length} explicit modules, zero npm runtime dependencies, no import cycle)`);
