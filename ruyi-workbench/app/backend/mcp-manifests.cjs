'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { RUYI_MCP_SERVER_ID, canonicalRuyiMcpServerId } = require('./product-identity.cjs');
const { TOOL_PACK_DESCRIPTIONS } = require('./tool-access-policy.cjs');
const { bridgedCliServerEnv, desktopMcpPolicyEnv } = require('./mcp-child-env.cjs');

const SESSION_MCP_CONFIG_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const PRIVATE_MANIFEST_WRITE = Object.freeze({ mode: 0o600, exclusiveTemp: true });

function createMcpManifests({ paths, runtime, hostFile, externalRoot, ensureDirs, readConfig, ensureDesktopMcpWarm,
  resolveExternalMcpServers, atomicWriteJson, process = globalThis.process }) {
  function externalServerJs() {
    const serverFile = path.join(externalRoot(), 'app', 'server.js');
    return fs.existsSync(serverFile) ? serverFile : '';
  }

  function bundledNodeExe() {
    const bundled = path.join(externalRoot(), 'runtime', 'node', 'bin', 'node');
    return fs.existsSync(bundled) ? bundled : process.execPath;
  }

  function commandForSelfMcp() {
    return { command: bundledNodeExe(), args: [externalServerJs() || path.resolve(hostFile), 'mcp'], via: 'node' };
  }

  function createManifest(env, config, { includeExternal, desktopOverride, allowed } = {}) {
    const mcpServers = {};
    if (!allowed || allowed.has(RUYI_MCP_SERVER_ID)) {
      const self = commandForSelfMcp();
      mcpServers[RUYI_MCP_SERVER_ID] = { type: 'stdio', command: self.command, args: self.args, env };
    }
    if (!config || !includeExternal) return { mcpServers };
    try {
      for (const entry of resolveExternalMcpServers(config)) {
        if (mcpServers[entry.id] || (allowed && !allowed.has(entry.id))) continue;
        if (entry.transport === 'sse' || entry.transport === 'http') {
          const server = { type: entry.transport, url: entry.url };
          if (entry.headers && Object.keys(entry.headers).length) server.headers = entry.headers;
          if (entry.bearerTokenEnvVar) server.bearerTokenEnvVar = entry.bearerTokenEnvVar;
          mcpServers[entry.id] = server;
        } else {
          const server = { type: 'stdio', command: entry.command, args: entry.args || [] };
          if (entry.cwd) server.cwd = entry.cwd;
          server.env = { ...bridgedCliServerEnv(entry.env, process.env), ...desktopMcpPolicyEnv(entry.id, config, desktopOverride) };
          mcpServers[entry.id] = server;
        }
      }
    } catch { /* Discovery is optional for manifest generation. */ }
    return { mcpServers };
  }

  function mcpConfigFilePath() { return path.join(paths.generated, 'workbench.mcp.json'); }

  async function generateMcpConfig(_mode) {
    await ensureDirs();
    const config = await readConfig().catch(() => null);
    // Resolve discovery off the event loop before converting the global manifest.
    await ensureDesktopMcpWarm(config);
    const file = mcpConfigFilePath();
    const manifest = createManifest({ RUYI_HOME: paths.data }, config, { includeExternal: true });
    await atomicWriteJson(file, manifest, PRIVATE_MANIFEST_WRITE);
    return file;
  }

  let sessionMcpConfigSweepDone = false;
  async function sweepStaleSessionMcpConfigs() {
    const names = await fsp.readdir(paths.generated);
    const cutoff = Date.now() - SESSION_MCP_CONFIG_MAX_AGE_MS;
    for (const name of names) {
      if (!/^workbench\.mcp\.[A-Za-z0-9_-]{1,64}\.json$/.test(name)) continue;
      const file = path.join(paths.generated, name);
      try {
        const stat = await fsp.stat(file);
        if (stat.isFile() && stat.mtimeMs < cutoff) await fsp.unlink(file);
      } catch { /* A concurrent removal or an unavailable file can be skipped. */ }
    }
  }

  async function writeScopedManifest(id, toolPacks, { desktopOverride, agentNode = false, allowedServerIds } = {}) {
    await ensureDirs();
    if (!sessionMcpConfigSweepDone) {
      sessionMcpConfigSweepDone = true;
      void sweepStaleSessionMcpConfigs().catch(() => {});
    }
    const config = await readConfig().catch(() => null);
    const env = {
      RUYI_HOME: paths.data,
      WCW_SESSION_ID: id,
      WCW_PORT: String(runtime.port),
      WCW_HOST: runtime.host,
      WCW_TOKEN: runtime.token,
      WCW_TOOL_LOADING_MODE: config?.toolLoadingMode || 'auto',
      WCW_TOOL_PACKS: Array.isArray(toolPacks) ? toolPacks.join(',') : '',
    };
    if (agentNode) env.WCW_DISABLE_USER_INPUT = '1';
    const allowed = Array.isArray(allowedServerIds) && allowedServerIds.length
      ? new Set(allowedServerIds.map(canonicalRuyiMcpServerId)) : null;
    const manifest = createManifest(env, config, {
      // Interactive adaptive sessions use invoke proxies. Exec nodes use direct servers.
      includeExternal: agentNode || config?.toolLoadingMode === 'full', desktopOverride, allowed,
    });
    const file = path.join(paths.generated, `workbench.mcp.${id}.json`);
    await atomicWriteJson(file, manifest, PRIVATE_MANIFEST_WRITE);
    return file;
  }

  function generateSessionMcpConfig(sessionId, _mode, toolPacks, opts) {
    return writeScopedManifest(sessionId, toolPacks, { desktopOverride: opts?.desktopOverride });
  }

  function generateAgentNodeMcpConfig(subagentId, _mode, allowedServerIds) {
    return writeScopedManifest(subagentId, Object.keys(TOOL_PACK_DESCRIPTIONS), { agentNode: true, allowedServerIds });
  }

  return { externalServerJs, bundledNodeExe, commandForSelfMcp, mcpConfigFilePath, generateMcpConfig,
    generateSessionMcpConfig, generateAgentNodeMcpConfig };
}

module.exports = { createMcpManifests };
