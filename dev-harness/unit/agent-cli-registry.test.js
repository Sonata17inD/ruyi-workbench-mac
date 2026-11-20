'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-engine-selection-'));
process.env.HOME = process.env.RUYI_HOME = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const server = require('../../ruyi-workbench/app/server.js');

test('registered execution engines match the adapter catalog', () => {
  assert.deepEqual(Object.keys(server.AGENT_CLI_TYPES), ['claude']);
  assert.deepEqual(Object.keys(server.AGENT_CLI_ADAPTERS), ['claude']);
  assert.equal(server.AGENT_CLI_TYPES.claude.label, 'Claude Code');
  assert.deepEqual(server.prepareAgentCliSpawn('claude', '/opt/Claude Code', ['--flag', 'two words']),
    { command: '/opt/Claude Code', args: ['--flag', 'two words'], opts: {} });
  assert.throws(() => server.prepareAgentCliSpawn('retired', '/invalid', []), /Unavailable CLI/);
});

test('unavailable drivers stay pinned until the user selects another engine', async () => {
  const route = { engine: 'agent', agentCliType: 'retired', model: 'old-model' };
  const session = await server.createSession({ cwd: root, engineRoute: route });
  session.claudeSessionId = 'old-native-id';
  session.injectedIndexHash = 'old-index';
  session.messages = [{ role: 'assistant', content: 'Original transcript', agentCliType: 'retired' }];
  await server.saveSession(session);
  for (const input of [{}, { source: 'scheduler', engineRoute: { engine: 'agent', agentCliType: 'claude' } }]) {
    await assert.rejects(server.runSessionTurn({ sessionId: session.id, message: 'continue', ...input }),
      { code: 'SESSION_ENGINE_UNAVAILABLE', statusCode: 409 });
  }
  const before = await server.loadSession(session.id);
  assert.deepEqual(before.engineRoute, route);
  assert.equal(before.claudeSessionId, 'old-native-id');
  await server.updateSessionMeta(session.id, { engineRoute: { engine: 'agent', agentCliType: 'claude' }, engineRouteScope: 'thread' });
  const after = await server.loadSession(session.id);
  assert.equal(after.engineRoute.agentCliType, 'claude');
  assert.equal(after.claudeSessionId, null);
  assert.equal(after.injectedIndexHash, null);
  assert.deepEqual(after.messages, before.messages);
});
