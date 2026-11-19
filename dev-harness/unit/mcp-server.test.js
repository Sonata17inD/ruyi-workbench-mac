'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { setImmediate: tick } = require('node:timers/promises');
const { createMcpServer } = require('../../ruyi-workbench/app/backend/mcp-server.cjs');
function fixture(overrides = {}) {
  const input = new PassThrough(), output = new PassThrough();
  const messages = []; let buffer = '', closes = 0, enabled = false;
  output.on('data', chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1);
    }
  });
  const server = createMcpServer({ input, output, env: {}, version: 'test', configPath: '/tmp/config.json',
    readConfig: async () => ({}),
    PrivacyGateway: { assertPolicyAvailable() {}, enabled: () => enabled, assertSupported() {
      if (enabled) throw Object.assign(new Error('privacy.engine_not_supported'), { code: 'privacy.engine_not_supported' });
    } },
    ProcessRuntime: { capabilitySnapshot: async () => ({}) }, observationRecallEnabled: () => true,
    policyDesktopOverrideFor: async () => ({}), runtimeToolRequirementsMet: () => ({ met: true }),
    nativeToolDisabledByPolicy: () => false, isStewardToolName: () => false, toolPackForName: () => 'core',
    toolCall: async () => ({ ok: true }), VisualPipeline: { extractToolImages: () => [] },
    truncateToolResult: (_name, value) => value, maskProviders: value => value, samePathKey: value => value,
    killAllMcpClients: () => { closes++; }, safeJsonParse: raw => { try { return JSON.parse(raw); } catch { return null; } },
    MCP_TOOLS: [{ name: 'file_read' }], ...overrides,
  });
  server.start();
  return { messages, input, closes: () => closes, enable: () => { enabled = true; },
    request: (id, method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') };
}
test('EOF drains accepted work; a late privacy change blocks result and error text', async () => {
  for (const reject of [false, true]) {
    let release;
    const f = fixture({ toolCall: () => new Promise((resolve, fail) => { release = () => reject ? fail(new Error('secret-path')) : resolve({ ok: true, text: 'secret-path' }); }) });
    f.request(1, 'tools/call', { name: 'file_read' });
    await tick(); f.input.end(); await tick();
    assert.equal(f.closes(), 0);
    f.enable(); release(); await tick();
    assert.equal(f.closes(), 1);
    assert.equal(f.messages[0].error.message, 'privacy.engine_not_supported');
    assert.ok(!JSON.stringify(f.messages).includes('secret-path'));
  }
});
test('tool listing and resources are hidden when privacy policy forbids the MCP engine', async () => {
  const f = fixture();
  f.enable(); f.request(1, 'tools/list'); f.request(2, 'resources/list');
  await tick();
  assert.deepEqual(f.messages.find(m => m.id === 1).result.tools, []);
  assert.deepEqual(f.messages.find(m => m.id === 2).result.resources, []);
  f.input.end(); await tick(); assert.equal(f.closes(), 1);
});
