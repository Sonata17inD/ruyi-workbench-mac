'use strict';

const { apiFailure, send } = require('./http-protocol.cjs');

function createWorkbenchApiRouter({
  authorizeRoute, privacyRoutes, ExternalBotHooks, StewardHooks, EventStreamHooks,
  handleStatusApiRoutes, handlePlaybookApiRoutes, handleWorkspaceApiRoutes, handleModelsApiRoute,
  handleConfigurationApiRoutes, handleProviderTestApiRoute, handleSessionApiRoutes, handleMissionsApiRoutes,
  handleSkillApiRoutes, handleMemoryApiRoutes, handleSessionExecutionApiRoutes, handleInterventionApiRoutes,
  handleMissionLedgerApiRoutes, handleAutonomyGrantApiRoutes, handleAgentWorkflowApiRoutes,
  handleUsageApiRoutes, handleAgentRunApiRoutes, handleCheckpointQueryApiRoutes, handleLocalSupportApiRoutes,
  handleMcpApiRoutes, handleDiagnosticsApiRoutes, handleCheckpointApiRoutes, handleSteerApiRoute, handleAudioApiRoutes,
  handleSchedulerApiRoutes, handleAttachmentApiRoutes, handleChatApiRoute, handleToolApiRoutes,
}) {
  async function handleApi(req, res, pathname) {
    // The HTTP listener enforces the host gate. Apply the route policy before calling any domain handler.
    const authErr = authorizeRoute(req, req.method, pathname);
    if (authErr) {
      const code = authErr === 'missing or invalid workbench token' ? 'auth.token_invalid'
        : authErr === 'cross-origin request rejected' ? 'auth.origin_rejected'
          : authErr === 'remote client not allowed' ? 'auth.remote_denied' : 'auth.denied';
      return send(res, apiFailure(code, {}, authErr, 403));
    }

    if (typeof privacyRoutes.handleApiRoutes === 'function' && await privacyRoutes.handleApiRoutes(req, res, pathname)) return;
    if (typeof ExternalBotHooks.handleApiRoutes === 'function') {
      const handled = await ExternalBotHooks.handleApiRoutes(req, res, pathname);
      if (handled || res.writableEnded || res.destroyed) return;
    }

    await handleStatusApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handlePlaybookApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleWorkspaceApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleModelsApiRoute(req, res, pathname); if (res.writableEnded) return;
    await handleConfigurationApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleProviderTestApiRoute(req, res, pathname); if (res.writableEnded) return;
    await handleSessionApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleMissionsApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleSkillApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleMemoryApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleSessionExecutionApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleInterventionApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleMissionLedgerApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleAutonomyGrantApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleAgentWorkflowApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleUsageApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleAgentRunApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleCheckpointQueryApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleLocalSupportApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleMcpApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleDiagnosticsApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleCheckpointApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleSteerApiRoute(req, res, pathname); if (res.writableEnded) return;
    await handleAudioApiRoutes(req, res, pathname); if (res.writableEnded) return;
    // 管家域在依赖装配完毕后注册路由。
    if (typeof StewardHooks.handleApiRoutes === 'function') { await StewardHooks.handleApiRoutes(req, res, pathname); if (res.writableEnded) return; }
    // 命中信号是 headersSent 而不是 writableEnded:SSE 连接【故意不 end】,一直开着流事件,
    // writableEnded 永远是 false,只看它会让这条请求继续往下走、最后撞上 404 那行的二次 writeHead。
    if (typeof EventStreamHooks.handleApiRoutes === 'function') { await EventStreamHooks.handleApiRoutes(req, res, pathname); if (res.headersSent || res.writableEnded) return; }
    await handleSchedulerApiRoutes(req, res, pathname); if (res.writableEnded) return;
    await handleAttachmentApiRoutes(req, res, pathname); if (res.writableEnded) return;
    if (await handleChatApiRoute(req, res, pathname)) return;
    await handleToolApiRoutes(req, res, pathname); if (res.writableEnded) return;
    return send(res, apiFailure('api.route_not_found', {}, 'Not found', 404));
  }

  return handleApi;
}

module.exports = { createWorkbenchApiRouter };
