'use strict';

const { DESKTOP_MCP_SERVER_ID, accPolicyHiddenToolNames } = require('./tool-access-policy.cjs');

const BRIDGED_CLI_ENV_BLANK_KEYS = Object.freeze([
  'WCW_TOKEN', 'WCW_PORT', 'WCW_HOST', 'WCW_SESSION_ID', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
]);
const MODEL_CREDENTIAL_KEYS = new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']);

function bridgedEnvKeyStripped(key) {
  const upper = key.toUpperCase();
  return (upper.startsWith('WCW_') && upper !== 'WCW_DATA_DIR') || MODEL_CREDENTIAL_KEYS.has(upper);
}

// The host controls the entire child environment when it spawns a bridged server.
function bridgedServerSpawnEnv(baseEnv, ownEnv) {
  const inherited = Object.fromEntries(Object.entries(baseEnv || {}).filter(([key]) => !bridgedEnvKeyStripped(key)));
  return { ...inherited, ...(ownEnv && typeof ownEnv === 'object' ? ownEnv : {}) };
}

// Agent CLIs overlay manifest env entries on their own environment. Blank inherited
// credentials and retain explicitly configured values for this server.
function bridgedCliServerEnv(ownEnv, baseEnv = process.env) {
  const blanks = {};
  for (const key of BRIDGED_CLI_ENV_BLANK_KEYS) blanks[key] = '';
  for (const key of Object.keys(baseEnv || {}).sort()) {
    if (bridgedEnvKeyStripped(key)) blanks[key] = '';
  }
  return { ...blanks, ...(ownEnv && typeof ownEnv === 'object' ? ownEnv : {}) };
}

function desktopMcpPolicyEnv(entryId, config, desktopOverride = null) {
  if (entryId !== DESKTOP_MCP_SERVER_ID || !config) return {};
  const hidden = accPolicyHiddenToolNames(config, desktopOverride);
  return hidden.length ? { ACC_HIDE_TOOLS: hidden.join(',') } : {};
}

module.exports = { bridgedServerSpawnEnv, bridgedCliServerEnv, desktopMcpPolicyEnv };
