'use strict';

const BRIDGED_TOOL_TIMEOUTS = {
  run_command: 650000,
  launch_application: 650000,
  macro_run: 300000,
  // ACC `wait` caps at 300s and time.sleep()s it; the old 120s bridge would kill a legitimate
  // wait(300) at 120s and tear down the whole ACC process tree for doing exactly what was asked.
  wait: 310000,
};
// Unknown third-party tools may legitimately render/export/index for several minutes without emitting MCP
// progress. Give them a bounded long-task ceiling; the provider stream now emits token-free liveness events,
// and Stop/steer can cancel the active request immediately, so this no longer creates an unresponsive wait.
const BRIDGED_TOOL_TIMEOUT_DEFAULT_MS = 900000;
function bridgedToolTimeoutMs(name) {
  const bare = String(name || '').toLowerCase();
  const ov = String(process.env.WCW_BRIDGED_TIMEOUT_OVERRIDE || '');
  for (const pair of ov.split(',')) {
    const [k, v] = pair.split(':').map(s => String(s || '').trim());
    if (k && k.toLowerCase() === bare && Number(v) > 0) return Number(v);
  }
  return BRIDGED_TOOL_TIMEOUTS[bare] || BRIDGED_TOOL_TIMEOUT_DEFAULT_MS;
}

// Match the bridge deadline to the concrete ACC run_command request instead of showing a default 60-second
// command as "running" for the old blanket 650-second ceiling. Keep a small protocol/serialization grace;
// explicit WCW_BRIDGED_TIMEOUT_OVERRIDE values remain the harder outer cap used by tests/operators.
function bridgedToolCallTimeoutMs(name, args) {
  const bare = String(name || '').toLowerCase();
  const configured = bridgedToolTimeoutMs(name);
  if (bare !== 'run_command') return configured;
  const requestedSeconds = Number(args && args.timeout);
  const commandSeconds = Number.isFinite(requestedSeconds)
    ? Math.max(1, Math.min(600, requestedSeconds))
    : 60;
  return Math.max(1000, Math.min(configured, commandSeconds * 1000 + 10000));
}

module.exports = { bridgedToolCallTimeoutMs };
