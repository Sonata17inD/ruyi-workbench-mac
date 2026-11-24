'use strict';

const { apiFailure, send } = require('./http-protocol.cjs');

function createWorkbenchApiRouter({
  authorizeRoute, handlePrivacyApiRoutes, handleExternalBotApiRoutes, handleStewardApiRoutes, handleEventStreamApiRoutes,
  handleStatusApiRoutes, handlePlaybookApiRoutes, handleWorkspaceApiRoutes, handleModelsApiRoute, handleCodexApiRoutes,
  handleConfigurationApiRoutes, handleProviderTestApiRoute, handleSessionApiRoutes, handleMissionsApiRoutes,
  handleSkillApiRoutes, handleMemoryApiRoutes, handleSessionExecutionApiRoutes, handleInterventionApiRoutes,
  handleMissionLedgerApiRoutes, handleAutonomyGrantApiRoutes, handleAgentWorkflowApiRoutes,
  handleUsageApiRoutes, handleAgentRunApiRoutes, handleCheckpointQueryApiRoutes, handleLocalSupportApiRoutes,
  handleMcpApiRoutes, handleDiagnosticsApiRoutes, handleCheckpointApiRoutes, handleSteerApiRoute, handleAudioApiRoutes,
  handleSchedulerApiRoutes, handleAttachmentApiRoutes, handleChatApiRoute, handleToolApiRoutes,
}) {
  const domains = new Map();
  function register(handler, ...segments) {
    for (const segment of segments) {
      const handlers = domains.get(segment);
      if (handlers) handlers.push(handler);
      else domains.set(segment, [handler]);
    }
  }

  register(handlePrivacyApiRoutes, 'privacy');
  register(handleExternalBotApiRoutes, 'external-bots');
  register(handleStatusApiRoutes, 'bootstrap', 'status', 'capabilities');
  register(handlePlaybookApiRoutes, 'playbooks');
  register(handleWorkspaceApiRoutes, 'workspace', 'pick-folder', 'pick-file');
  register(handleModelsApiRoute, 'models');
  register(handleCodexApiRoutes, 'codex');
  register(handleConfigurationApiRoutes, 'config', 'agent-roles', 'agent-workflows');
  register(handleProviderTestApiRoute, 'provider');
  register(handleSessionApiRoutes, 'sessions');
  register(handleMissionsApiRoutes, 'missions');
  register(handleSkillApiRoutes, 'skills', 'session');
  register(handleMemoryApiRoutes, 'memory', 'session');
  register(handleSessionExecutionApiRoutes, 'stop', 'provider', 'agent');
  register(handleInterventionApiRoutes, '_test', 'missions', 'interventions', 'chat', 'question', 'permission', 'plan');
  register(handleMissionLedgerApiRoutes, 'todo', 'mission');
  register(handleAutonomyGrantApiRoutes, 'autonomy');
  register(handleAgentWorkflowApiRoutes, 'agent-workflow');
  register(handleUsageApiRoutes, 'usage', 'ops');
  register(handleAgentRunApiRoutes, 'agent-runs');
  register(handleCheckpointQueryApiRoutes, 'checkpoints');
  register(handleLocalSupportApiRoutes, 'help', 'open-path', 'logs', 'file');
  register(handleMcpApiRoutes, 'mcp', 'migration');
  register(handleDiagnosticsApiRoutes, 'audit', 'storage', 'metrics');
  register(handleCheckpointApiRoutes, 'storage', 'checkpoints', 'session');
  register(handleSteerApiRoute, 'steer');
  register(handleAudioApiRoutes, 'audio');
  register(handleStewardApiRoutes, 'steward');
  register(handleEventStreamApiRoutes, 'events');
  register(handleSchedulerApiRoutes, 'scheduler');
  register(handleAttachmentApiRoutes, 'upload');
  register(handleChatApiRoute, 'chat');
  register(handleToolApiRoutes, 'tools');

  async function handleApi(req, res, pathname) {
    // The HTTP listener enforces the host gate. Apply the route policy before calling any domain handler.
    const authErr = authorizeRoute(req, req.method, pathname);
    if (authErr) {
      const code = authErr === 'missing or invalid workbench token' ? 'auth.token_invalid'
        : authErr === 'cross-origin request rejected' ? 'auth.origin_rejected'
          : authErr === 'remote client not allowed' ? 'auth.remote_denied' : 'auth.denied';
      return send(res, apiFailure(code, {}, authErr, 403));
    }

    const segment = pathname.split('/', 3)[2];
    const handlers = domains.get(segment);
    if (handlers) {
      for (const handle of handlers) {
        const handled = await handle(req, res, pathname);
        if (handled === true || res.headersSent || res.writableEnded || res.destroyed) return;
      }
    }
    return send(res, apiFailure('api.route_not_found', {}, 'Not found', 404));
  }

  return handleApi;
}

module.exports = { createWorkbenchApiRouter };
