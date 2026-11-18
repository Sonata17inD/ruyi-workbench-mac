// Root execution authority. MCP children never open this ledger; they need the root service.
const DesktopExecutionRuntime = require('./backend/desktop-execution-runtime.cjs').createDesktopExecutionRuntime({
  host: { ServerOwnership, activeAgentRuns, paths, process, turnSettlers },
  ledger: { DesktopExecutionLedger },
  connector: { McpStdioClient, isEquivalentDesktopAccServer, mcpClients, probeDesktopExecutionReceipts },
  sessions: { loadSession, saveSession, sessionObjectIsStale, sessionRewindGenHighWater, sessionSaveIsTombstoned },
});

Object.assign(DesktopExecutionHooks, DesktopExecutionRuntime);
ProviderHttpHooks.beforeModelRequest = DesktopExecutionRuntime.beforeModelRequest;
