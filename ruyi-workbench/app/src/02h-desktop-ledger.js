// Root-owned execution preparation/result ledger; this factory itself performs no MCP/native IO.
// The default-off root/provider candidate supplies actual OS ownership and live turn assertions.
// The state file holds identity fields, digests and flags. Explicit delivery snapshots are private, bounded,
// immutable files containing the actual projected consumer history, not raw ACC results.
const DesktopExecutionLedger = require('./backend/desktop-execution-ledger.cjs').createDesktopExecutionLedger({
  storage: { DurableJsonStore, runKeyedChain },
  execution: { nowIso, prepareDesktopExecutionArguments, process },
});
