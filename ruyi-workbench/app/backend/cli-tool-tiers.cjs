'use strict';

const { nativeToolTier } = require('./native-tool-tiers.cjs');

const CLI_TOOL_TIER = Object.freeze({
  Read: 'read', Glob: 'read', Grep: 'read', LS: 'read',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'exec',
});

function knownCliToolTier(name) {
  return Object.hasOwn(CLI_TOOL_TIER, name) ? CLI_TOOL_TIER[name] : null;
}

function cliBridgeToolTier(name) {
  return knownCliToolTier(name) || nativeToolTier(name);
}

module.exports = { knownCliToolTier, cliBridgeToolTier };
