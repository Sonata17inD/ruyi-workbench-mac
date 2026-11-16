'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFileToolPaths } = require('../../ruyi-workbench/app/backend/file-tool-paths.cjs');
test('file paths resolve against execution, session, MCP and configured workspace in that order', async () => {
  let sessionReads = 0, configReads = 0, mcp = 'child';
  const paths = createFileToolPaths({ getMcpSessionId: () => mcp,
    loadSession: async () => { sessionReads++; return { cwd: '/mcp' }; },
    readConfig: async () => { configReads++; return { defaultWorkspace: '/configured' }; },
    normalizeCwd: (_, fallback) => fallback || '/home',
  });
  assert.equal(await paths.resolveFileToolPath('a', { workingDir: '/turn', session: { cwd: '/session' } }), '/turn/a');
  assert.equal(await paths.resolveFileToolRoot({ root: 'a' }, { session: { cwd: '/session' } }), '/session/a');
  assert.equal(sessionReads, 0); assert.equal(configReads, 0);
  assert.equal(await paths.resolveFileToolPath('a', {}), '/mcp/a');
  mcp = ''; assert.equal(await paths.resolveFileToolPath('a', {}), '/configured/a');
  assert.equal(await paths.resolveFileToolPath('/absolute', {}), '/absolute');
  assert.equal(configReads, 1);
  assert.equal(await paths.resolveFileToolPath('%TEMP%/a', { workingDir: '/turn' }), '/turn/%TEMP%/a');
});
