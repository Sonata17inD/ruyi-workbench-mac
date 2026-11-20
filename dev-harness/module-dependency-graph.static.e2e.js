#!/usr/bin/env node
'use strict';
// Wave 103b static gate: dependency contracts are reproducible, duplicate globals are forbidden, and the
// explicit debt ceiling rejects new cycle/forward-order edges. Also locks the first namespace isolation pilot.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  buildGraph, policyViolations, tokenize, declarationInfo,
} = require('./module-dependency-graph');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail++; console.log('FAIL ' + label); }
};

const checked = cp.spawnSync(process.execPath, [path.join(__dirname, 'module-dependency-graph.js'), '--check'], {
  cwd: ROOT, encoding: 'utf8',
});
ok(checked.status === 0, '103b generated contract and human/machine graphs match source byte-for-byte');
if (checked.status !== 0) console.log(String(checked.stdout || '') + String(checked.stderr || ''));
// 架构还债批 2:提交件不记 app/src 行号(加一行注释就要重算几万行的根因)。两份 JSON 生成物里都不许出现行号字段。
for (const rel of ['docs/architecture/module-dependency-graph.json', 'ruyi-workbench/app/src/module-contracts.json']) {
  const text = fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
  const hits = text.match(/"lines?"\s*:/g) || [];
  ok(hits.length === 0, `${rel} 不含行号字段(实得 ${hits.length} 处)`);
}

const graph = buildGraph();
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(SRC, 'module-dependency-policy.json'), 'utf8'));
const violations = policyViolations(graph, policy);
ok(graph.modules.length === manifest.modules.length && graph.modules.every((module, index) => module.file === manifest.modules[index].file),
  '103b graph covers every manifest module in concatenation order');
ok(graph.duplicateProvides.length === 0, '103b no duplicate top-level provides');
ok(violations.cycles.length === 0 && graph.stronglyConnectedComponents.length === 0,
  'production source has no strongly connected modules');
const fixtureCycle = 'left.js->right.js';
ok(policyViolations({ cycleEdgeKeys: [fixtureCycle], forwardEdgeKeys: [] }, { allowedCycleEdges: [fixtureCycle] })
  .cycles.includes(fixtureCycle), 'a policy file cannot exempt a production dependency cycle');
ok(violations.forward.length === 0, '103b no forward/order-layer edge above the reviewed debt ceiling');

// Scanner adversarial: declarations in comments/strings are ignored, template interpolation remains visible,
// and multi-declarator/destructuring bindings become provides. This protects the contract mechanism itself.
const fixture = [
  "const first = 1, second = `${externalCall(first)}`;",
  "const { URL, pathToFileURL } = require('url');",
  "// function fakeProvide() {}",
  "const text = 'hiddenIdentifier()';",
  'function realProvide() { return second; }',
].join('\n');
const fixtureTokens = tokenize(fixture);
const fixtureDeclarations = declarationInfo(fixtureTokens).provides.map(item => item.name).sort();
ok(JSON.stringify(fixtureDeclarations) === JSON.stringify(['URL', 'first', 'pathToFileURL', 'realProvide', 'second', 'text']),
  '103b scanner finds top-level multi/deconstructed declarations without comment/string ghosts');
ok(fixtureTokens.some(token => token.value === 'externalCall') && !fixtureTokens.some(token => token.value === 'hiddenIdentifier'),
  '103b scanner retains template-expression reads and discards quoted text');
const executableDeclarations = declarationInfo(tokenize('#!/usr/bin/env node\n' + fixture)).provides.map(item => item.name).sort();
ok(JSON.stringify(executableDeclarations) === JSON.stringify(fixtureDeclarations),
  'platform entry hashbang does not hide declarations or create spurious dependency symbols');

const divisionFixture = [
  'const ratio = 1024 / 2; function afterNumber() {}',
  "const textRatio = '4' / 2; function afterString() {}",
  'const templateRatio = `4` / 2; function afterTemplate() {}',
  'const matcher = /[{}]/g; function afterRegex() {}',
].join('\n');
const divisionNames = declarationInfo(tokenize(divisionFixture)).provides.map(item => item.name).sort();
ok(JSON.stringify(divisionNames) === JSON.stringify(['afterNumber', 'afterRegex', 'afterString', 'afterTemplate', 'matcher', 'ratio', 'templateRatio', 'textRatio']),
  'literal division and regex braces cannot hide later declarations');

const { createAgentLoopHooks } = require('../ruyi-workbench/app/backend/agent-loop-hooks.cjs');
const hooks = createAgentLoopHooks({ makeId: () => 'fixture-trace', logEvent: () => {}, redact: String });
ok(Object.isFrozen(hooks) && Object.keys(hooks).length === 7 && hooks.makeAgentLoopTraceId() === 'fixture-trace',
  'Agent loop hooks expose seven operations and use the injected trace generator');
const operations = graph.modules.find(item => item.file === '04-permission-runtime.js');
const hookAssembly = fs.readFileSync(path.join(SRC, operations.file), 'utf8');
ok(/createAgentLoopHooks\(\{\s*makeId, logEvent: .*?, redact,\s*\}\)/s.test(hookAssembly),
  'Agent loop composition injects trace generation, logging and redaction');
for (const consumer of ['05-claude-engine.js', '09-workflow.js', '14-main.js']) {
  const module = graph.modules.find(item => item.file === consumer);
  ok(module && module.requires.some(req => req.provider === operations.file && req.symbol === 'AgentLoopHooks'),
    consumer + ' consumes the shared AgentLoopHooks instance');
}

console.log(`\nMODULE DEPENDENCY GRAPH STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
