// Both discovery and execution use one cached capability matrix.
const probeDesktopMcp = require('./backend/desktop-capability-probe.cjs').createDesktopCapabilityProbe({
  collectBridgedTools, resolveExternalMcpServers, sanitizeServerId, DesktopExecutionHooks,
  getMcpClient: id => mcpClients.get(id),
});
const { CAP_UNKNOWN_TTL_MS, createCapabilityService } = require('./backend/capability-service.cjs');
const { getCapabilities, peekCapabilities, invalidateCapabilityCache, markNetworkOnline, networkAnchors, probeAny } =
  createCapabilityService({
    readConfig, nowIso, providerBaseIsLocalOrLan, providerBaseWithV1,
    probeDesktopMcp, probeRgAsync, existsExecutableAsync, probeGitCliAsync,
    runtimeCapabilitySnapshot: () => ProcessRuntime.capabilitySnapshot(),
  });
