'use strict';

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mcp-manifests-'));
const data = path.join(home, 'data');
const generated = path.join(data, 'generated');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.RUYI_HOME = data;
fs.mkdirSync(generated, { recursive: true });
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { generateAgentNodeMcpConfig, generateSessionMcpConfig } = require('../lib/server-internals').loadServerInternals([
  'generateAgentNodeMcpConfig', 'generateSessionMcpConfig',
]);
const config = {
  configSchema: 14, credentialEncryptionV1: false, toolLoadingMode: 'full',
  autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
  desktopMcp: { enabled: false, autodetect: false },
  externalMcpServers: [
    { id: 'allowed', transport: 'http', url: 'http://127.0.0.1:1/mcp', enabled: true },
    { id: 'excluded', command: process.execPath, enabled: true },
  ],
};

function writeConfig(overrides) {
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ ...config, ...overrides }));
}

test('an exec node publishes only its filtered manifest with user input disabled', async t => {
  writeConfig();
  const file = path.join(generated, 'workbench.mcp.node_allowed.json');
  const publications = [];
  const rename = fsp.rename;
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (to === file) publications.push(JSON.parse(await fsp.readFile(from, 'utf8')));
    return rename(from, to);
  });

  const result = await generateAgentNodeMcpConfig('node_allowed', 'auto', ['win-claude-workbench', 'allowed']);
  assert.equal(result, file);
  assert.equal(publications.length, 1);
  const { mcpServers } = publications[0];
  assert.deepEqual(Object.keys(mcpServers), ['ruyi', 'allowed']);
  assert.equal(mcpServers.ruyi.env.WCW_DISABLE_USER_INPUT, '1');
  assert.equal(mcpServers.ruyi.env.WCW_SESSION_ID, 'node_allowed');
  assert.equal(mcpServers.ruyi.env.RUYI_HOME, data);
  assert.deepEqual(mcpServers.allowed, { type: 'http', url: 'http://127.0.0.1:1/mcp' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), publications[0]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a failed exec-node publication rejects and leaves no unfiltered manifest or temporary file', async t => {
  writeConfig();
  const file = path.join(generated, 'workbench.mcp.node_failed.json');
  const previous = '{"mcpServers":{}}';
  fs.writeFileSync(file, previous);
  const rename = fsp.rename;
  const failure = Object.assign(new Error('manifest publication failed'), { code: 'EACCES' });
  const attempts = [];
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (to !== file) return rename(from, to);
    attempts.push(JSON.parse(await fsp.readFile(from, 'utf8')));
    throw failure;
  });

  await assert.rejects(generateAgentNodeMcpConfig('node_failed', 'auto', ['allowed']), failure);
  assert.equal(attempts.length, 1);
  assert.deepEqual(Object.keys(attempts[0].mcpServers), ['allowed']);
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  assert.ok(!fs.readdirSync(generated).some(name => name.startsWith(`${path.basename(file)}.`)));
});

test('adaptive sessions use proxies and adaptive exec nodes keep direct attachment when unrestricted', async () => {
  writeConfig({ toolLoadingMode: 'auto' });
  const session = await generateSessionMcpConfig('sess_adaptive', 'auto', ['core']);
  const node = await generateAgentNodeMcpConfig('node_adaptive', 'auto', []);
  const sessionServers = JSON.parse(fs.readFileSync(session, 'utf8')).mcpServers;
  const nodeServers = JSON.parse(fs.readFileSync(node, 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(sessionServers), ['ruyi']);
  assert.equal(sessionServers.ruyi.env.WCW_DISABLE_USER_INPUT, undefined);
  assert.equal(sessionServers.ruyi.env.WCW_TOOL_PACKS, 'core');
  assert.deepEqual(Object.keys(nodeServers), ['ruyi', 'allowed', 'excluded']);
  assert.equal(nodeServers.ruyi.env.WCW_DISABLE_USER_INPUT, '1');
});
